const express = require('express');
const { spawn, exec } = require('child_process');
const util = require('util');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const cors = require('cors');
require('dotenv').config();

const app = express();
const execPromise = util.promisify(exec);

// ============================================
// CORS CONFIGURATION
// ============================================
const allowedOrigins = [
    'https://thereaper987.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'https://repo-chat-wkqk.onrender.com'
];

const corsOptions = {
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        console.warn(`❌ CORS blocked: ${origin}`);
        return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'api-secret', 'x-api-secret', 'Authorization'],
    exposedHeaders: ['Content-Type', 'api-secret'],
    credentials: true,
    maxAge: 86400
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
// NO STATIC FILE SERVING - API ONLY

// ============================================
// CONFIGURATION
// ============================================
const API_SECRET = process.env.API_SECRET;
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS) || 3;
const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT) || 3 * 60 * 60 * 1000;
const EXECUTION_TIMEOUT = parseInt(process.env.EXECUTION_TIMEOUT) || 7200;
const MAX_CODE_SIZE = parseInt(process.env.MAX_CODE_SIZE) || 3 * 1024 * 1024;
const COMPLETED_EXECUTIONS_TTL = parseInt(process.env.COMPLETED_EXECUTIONS_TTL) || 10 * 60 * 1000;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL) || 15000;
const SESSIONS_BASE_DIR = process.env.SESSIONS_BASE_DIR || path.join(os.tmpdir(), 'colab_sessions');

// Colab binary configuration (matches original behavior)
let COLAB_BINARY = 'colab';
let USE_PYTHON_MODULE = false;

// ============================================
// COLAB BINARY SETUP (EXACTLY LIKE ORIGINAL)
// ============================================

async function findColabBinaryRecursive() {
    const { execSync } = require('child_process');
    console.log('🔍 Searching for colab binary...');
    
    // Try 1: which colab
    try {
        const whichPath = execSync('which colab 2>/dev/null || echo ""', { encoding: 'utf8', timeout: 5000 }).trim();
        if (whichPath && whichPath !== '') {
            console.log(`✅ Found colab via which: ${whichPath}`);
            return whichPath;
        }
    } catch(e) {}

    // Try 2: pip location
    try {
        const pipPath = execSync('pip3 show google-colab-cli 2>/dev/null | grep Location | cut -d" " -f2', { encoding: 'utf8', timeout: 5000 }).trim();
        if (pipPath) {
            console.log(`📦 pip location: ${pipPath}`);
            const possibleBinary = `${pipPath}/colab_cli/__main__.py`;
            if (require('fs').existsSync(possibleBinary)) {
                console.log(`✅ Found colab via pip: ${possibleBinary}`);
                return 'python3';
            }
        }
    } catch(e) {}

    // Try 3: Search common paths
    const searchPaths = [
        '/opt/render/.local/bin',
        '/usr/local/bin', 
        '/usr/bin',
        '/opt/render/project/.local/bin',
        '/home/render/.local/bin',
        '/opt/render/project/src/.local/bin'
    ];
    
    for (const searchPath of searchPaths) {
        try {
            const result = execSync(`find ${searchPath} -name "colab" -type f 2>/dev/null | head -1`, { encoding: 'utf8', timeout: 10000 }).trim();
            if (result && result !== '') {
                console.log(`✅ Found colab via recursive search: ${result}`);
                try {
                    execSync(`chmod +x "${result}"`, { stdio: 'ignore' });
                } catch(e) {}
                return result;
            }
        } catch(e) {}
    }

    // Try 4: Check existing binary
    const existingBinary = path.join(__dirname, 'colab');
    if (require('fs').existsSync(existingBinary)) {
        try {
            const content = require('fs').readFileSync(existingBinary, 'utf8').slice(0, 200);
            if (content.includes('python') || content.includes('#!/')) {
                console.log(`✅ Existing binary is a Python script, using python3 -m colab_cli`);
                return 'python3';
            }
        } catch(e) {}
    }

    console.warn('⚠️ colab binary not found, will use python3 -m colab_cli');
    return 'python3';
}

async function initColabBinary() {
    const binary = await findColabBinaryRecursive();
    if (binary === 'python3') {
        USE_PYTHON_MODULE = true;
        COLAB_BINARY = 'python3';
        console.log(`🔧 Using Python module: ${COLAB_BINARY} -m colab_cli`);
    } else {
        COLAB_BINARY = binary;
        USE_PYTHON_MODULE = false;
        console.log(`🔧 Using colab binary: ${COLAB_BINARY}`);
    }
}

// ============================================
// COLAB CLI RUNNER
// ============================================

const execPromise = util.promisify(exec);

async function runColabCli(args, timeout = 30000) {
    return new Promise((resolve, reject) => {
        let command;
        if (USE_PYTHON_MODULE) {
            const escapedArgs = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
            command = `${COLAB_BINARY} -m colab_cli ${escapedArgs}`;
        } else {
            const escapedArgs = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
            command = `${COLAB_BINARY} ${escapedArgs}`;
        }
        console.log(`Running: ${command}`);
        exec(command, { timeout, shell: '/bin/bash', maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error && error.code !== 0) {
                console.error(`Command failed: ${error.message}`);
                reject({ error, stdout, stderr });
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

// ============================================
// AUTH SETUP - FIXED: Supports "token" field
// ============================================

async function setupColabAuth() {
    if (!process.env.COLAB_AUTH_TOKEN) {
        console.warn('⚠️ COLAB_AUTH_TOKEN not found in environment');
        return false;
    }

    try {
        let rawToken = process.env.COLAB_AUTH_TOKEN.trim();
        if ((rawToken.startsWith("'") && rawToken.endsWith("'")) || 
            (rawToken.startsWith('"') && rawToken.endsWith('"'))) {
            rawToken = rawToken.slice(1, -1);
            console.log('📝 Stripped surrounding quotes from token');
        }

        const tokenData = JSON.parse(rawToken);
        
        // ✅ FIX: Support "token" field by converting to "access_token"
        if (tokenData.token && !tokenData.access_token) {
            tokenData.access_token = tokenData.token;
            console.log('📝 Converted "token" field to "access_token"');
        }
        
        console.log('✅ Parsed COLAB_AUTH_TOKEN successfully');
        
        const configDir = path.join(os.homedir(), '.config/colab-cli');
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
            path.join(configDir, 'token.json'), 
            JSON.stringify(tokenData, null, 2)
        );
        console.log('✅ Written token.json');

        // Also write sessions.json to match Colab CLI expectations
        await fs.writeFile(
            path.join(configDir, 'sessions.json'), 
            JSON.stringify({})
        );
        console.log('✅ Written sessions.json');
        
        // Verify the token was written correctly
        const verifyToken = await fs.readFile(path.join(configDir, 'token.json'), 'utf8');
        const parsed = JSON.parse(verifyToken);
        if (parsed.access_token) {
            console.log('✅ Token verification passed');
            return true;
        } else {
            console.warn('⚠️ Token verification failed - no access_token found');
            return false;
        }
    } catch (error) {
        console.error('❌ Auth setup failed:', error.message);
        return false;
    }
}

// ============================================
// SESSION MANAGEMENT
// ============================================

async function createSessionFolder(sessionId) {
    const sessionFolder = path.join(SESSIONS_BASE_DIR, sessionId);
    await fs.mkdir(sessionFolder, { recursive: true });
    return sessionFolder;
}

async function cleanupSessionFolder(sessionId) {
    const sessionFolder = path.join(SESSIONS_BASE_DIR, sessionId);
    try {
        await fs.rm(sessionFolder, { recursive: true, force: true });
        console.log(`✅ Cleaned up folder for session ${sessionId}`);
    } catch (error) {
        console.error(`Failed to cleanup folder for ${sessionId}:`, error.message);
    }
}

// ============================================
// SESSION DATA JSON MANAGEMENT
// ============================================

async function appendSessionData(sessionId, data) {
    const sessionFolder = path.join(SESSIONS_BASE_DIR, sessionId);
    const dataFile = path.join(sessionFolder, 'session_data.json');
    
    try {
        let sessionData = {};
        try {
            const content = await fs.readFile(dataFile, 'utf8');
            sessionData = JSON.parse(content);
        } catch (e) {
            sessionData = {
                sessionId: sessionId,
                createdAt: new Date().toISOString(),
                cells: [],
                totalCells: 0,
                totalExecutions: 0
            };
        }
        
        sessionData.cells.push(data);
        sessionData.totalCells = sessionData.cells.length;
        sessionData.totalExecutions = sessionData.cells.filter(c => c.type === 'execution').length;
        sessionData.lastUpdated = new Date().toISOString();
        
        await fs.writeFile(dataFile, JSON.stringify(sessionData, null, 2));
        return sessionData;
    } catch (error) {
        console.error(`Failed to append session data for ${sessionId}:`, error.message);
        return null;
    }
}

async function getSessionData(sessionId) {
    const sessionFolder = path.join(SESSIONS_BASE_DIR, sessionId);
    const dataFile = path.join(sessionFolder, 'session_data.json');
    
    try {
        const content = await fs.readFile(dataFile, 'utf8');
        return JSON.parse(content);
    } catch (e) {
        return null;
    }
}

// ============================================
// API HELPERS
// ============================================

function validateApiSecret(input) {
    if (!input) return false;
    return input === API_SECRET;
}

function extractApiSecret(req) {
    return req.body?.api_secret || 
           req.headers['api-secret'] || 
           req.headers['x-api-secret'];
}

function generateSessionId() {
    return crypto.randomBytes(32).toString('hex');
}

function formatMemory(bytes) {
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// ============================================
// STATE MANAGEMENT
// ============================================

const sessions = new Map();
const executionQueue = new Set();
const completedExecutions = new Map();
const executionProcesses = new Map();

// Cleanup completed executions periodically
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [execId, data] of completedExecutions.entries()) {
        if (now - data.completedAt > COMPLETED_EXECUTIONS_TTL) {
            completedExecutions.delete(execId);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`🧹 Cleaned ${cleaned} completed executions from memory`);
    }
}, 60 * 1000);

// Cleanup hanging processes (safety net)
setInterval(() => {
    const now = Date.now();
    for (const [execId, process] of executionProcesses.entries()) {
        try {
            process.kill(0);
            const session = Array.from(sessions.values()).find(s => 
                s.currentExecution?.executionId === execId
            );
            if (session && Date.now() - session.currentExecution.startedAt > 2.5 * 60 * 60 * 1000) {
                console.log(`⚠️ Killing hanging process ${execId}`);
                process.kill('SIGTERM');
                executionProcesses.delete(execId);
            }
        } catch {
            executionProcesses.delete(execId);
        }
    }
}, 5 * 60 * 1000);

// ============================================
// CODE EXECUTION
// ============================================

async function executeCodeInColab(sessionId, cellNo, code, executionId) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    const startedAt = Date.now();
    let process = null;
    let cellData = {
        type: 'execution',
        cellNo: cellNo,
        startedAt: new Date(startedAt).toISOString(),
        code: code,
        status: 'running'
    };
    
    try {
        if (Buffer.byteLength(code, 'utf8') > MAX_CODE_SIZE) {
            throw new Error(`Code exceeds ${MAX_CODE_SIZE} bytes`);
        }

        const sessionFolder = path.join(SESSIONS_BASE_DIR, sessionId);
        const codeFile = path.join(sessionFolder, `code_${cellNo}.py`);
        await fs.writeFile(codeFile, code, 'utf8');

        const escapedCode = code
            .replace(/\\/g, '\\\\')
            .replace(/`/g, '\\`')
            .replace(/\$/g, '\\$')
            .replace(/"/g, '\\"');

        let command;
        if (USE_PYTHON_MODULE) {
            command = `echo "${escapedCode}" | python3 -m colab_cli exec -s ${session.colabSession} --timeout ${EXECUTION_TIMEOUT}`;
        } else {
            command = `echo "${escapedCode}" | ${COLAB_BINARY} exec -s ${session.colabSession} --timeout ${EXECUTION_TIMEOUT}`;
        }

        process = exec(command, { 
            timeout: EXECUTION_TIMEOUT * 1000, 
            maxBuffer: 50 * 1024 * 1024,
            shell: '/bin/bash'
        });

        executionProcesses.set(executionId, process);

        let stdout = '';
        let stderr = '';

        process.stdout.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;
            
            const currentSession = sessions.get(sessionId);
            if (currentSession && currentSession.currentExecution?.executionId === executionId) {
                currentSession.currentExecution.partialOutput = stdout;
                currentSession.currentExecution.partialError = stderr;
                sessions.set(sessionId, currentSession);
            }
        });

        process.stderr.on('data', (data) => {
            const chunk = data.toString();
            stderr += chunk;
            
            const currentSession = sessions.get(sessionId);
            if (currentSession && currentSession.currentExecution?.executionId === executionId) {
                currentSession.currentExecution.partialOutput = stdout;
                currentSession.currentExecution.partialError = stderr;
                sessions.set(sessionId, currentSession);
            }
        });

        const result = await new Promise((resolve, reject) => {
            process.on('close', (code) => {
                if (code !== 0) {
                    reject({ error: new Error(`Process exited with code ${code}`), stdout, stderr });
                } else {
                    resolve({ stdout, stderr });
                }
            });
            
            process.on('error', (err) => {
                reject({ error: err, stdout, stderr });
            });
        });

        const completedAt = Date.now();
        const executionTime = completedAt - startedAt;
        const output = { 
            status: 'completed', 
            output: result.stdout || '(No output)', 
            error: result.stderr || '',
            startedAt, 
            completedAt,
            executionTime
        };
        
        completedExecutions.set(executionId, output);
        executionProcesses.delete(executionId);

        const updatedSession = sessions.get(sessionId);
        if (updatedSession && updatedSession.currentExecution?.executionId === executionId) {
            updatedSession.currentExecution = null;
            updatedSession.status = 'ready';
            sessions.set(sessionId, updatedSession);
        }

        cellData.status = 'completed';
        cellData.completedAt = new Date(completedAt).toISOString();
        cellData.executionTime = executionTime;
        cellData.output = result.stdout || '(No output)';
        cellData.error = result.stderr || '';
        await appendSessionData(sessionId, cellData);

        console.log(`✅ Execution ${executionId} completed in ${executionTime}ms`);
        return output;
    } catch (error) {
        const completedAt = Date.now();
        const failureResult = {
            status: 'failed',
            output: error.stdout || '',
            error: error.stderr || error.message || String(error),
            startedAt,
            completedAt,
            executionTime: completedAt - startedAt
        };
        completedExecutions.set(executionId, failureResult);
        executionProcesses.delete(executionId);

        const updatedSession = sessions.get(sessionId);
        if (updatedSession && updatedSession.currentExecution?.executionId === executionId) {
            updatedSession.currentExecution = null;
            updatedSession.status = 'ready';
            sessions.set(sessionId, updatedSession);
        }

        cellData.status = 'failed';
        cellData.completedAt = new Date(completedAt).toISOString();
        cellData.executionTime = completedAt - startedAt;
        cellData.output = error.stdout || '';
        cellData.error = error.stderr || error.message || String(error);
        await appendSessionData(sessionId, cellData);

        console.error(`❌ Execution ${executionId} failed:`, error.message);
        throw error;
    }
}

async function backgroundExecution(sessionId, cellNo, code, executionId) {
    const execKey = `${sessionId}_${cellNo}`;
    if (executionQueue.has(execKey)) return;
    
    executionQueue.add(execKey);
    console.log(`📋 Queued execution ${executionId} for session ${sessionId}, cell ${cellNo}`);
    try {
        await executeCodeInColab(sessionId, cellNo, code, executionId);
    } catch (error) {
        console.error(`💥 Background error for ${executionId}:`, error.message);
    } finally {
        executionQueue.delete(execKey);
        console.log(`📋 Removed execution ${executionId} from queue`);
    }
}

// ============================================
// API ENDPOINTS
// ============================================

app.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();
    const now = new Date().toISOString();
    console.log(`💚 Health check at ${now}, ${sessions.size} active sessions`);
    
    res.json({
        status: 'healthy',
        activeSessions: sessions.size,
        maxSessions: MAX_SESSIONS,
        sessionDetails: Array.from(sessions.entries()).map(([id, s]) => ({
            id: id.slice(0, 12) + '...',
            colabSession: s.colabSession,
            createdAt: new Date(s.createdAt).toISOString(),
            lastActivity: new Date(s.lastActivity).toISOString(),
            status: s.status,
            hasCurrentExecution: !!s.currentExecution
        })),
        completedExecutions: completedExecutions.size,
        queuedExecutions: executionQueue.size,
        uptime: process.uptime(),
        memoryUsage: {
            rss: formatMemory(memUsage.rss),
            heapTotal: formatMemory(memUsage.heapTotal),
            heapUsed: formatMemory(memUsage.heapUsed),
            external: formatMemory(memUsage.external),
            arrayBuffers: formatMemory(memUsage.arrayBuffers)
        },
        timestamp: now,
        colabBinary: COLAB_BINARY,
        usePythonModule: USE_PYTHON_MODULE,
        hasAuthToken: !!process.env.COLAB_AUTH_TOKEN
    });
});

app.get('/health/simple', (req, res) => {
    res.json({
        status: 'up',
        timestamp: new Date().toISOString(),
        sessions: sessions.size
    });
});

// ============================================
// DEBUG ENDPOINTS (with auth)
// ============================================

app.get('/debug/sessions', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        console.warn(`🔒 Auth failed for /debug/sessions`);
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const memUsage = process.memoryUsage();
    const sessionData = [];
    let totalCells = 0;
    let totalExecutions = 0;

    for (const [id, session] of sessions.entries()) {
        const dataFile = await getSessionData(id);
        const cellsCount = dataFile?.cells?.length || 0;
        const executionsCount = dataFile?.totalExecutions || 0;
        totalCells += cellsCount;
        totalExecutions += executionsCount;

        const activeMinutes = ((Date.now() - session.createdAt) / 1000 / 60).toFixed(2);
        
        sessionData.push({
            sessionId: id,
            colabSession: session.colabSession,
            status: session.status,
            createdAt: new Date(session.createdAt).toISOString(),
            lastActivity: new Date(session.lastActivity).toISOString(),
            activeMinutes: parseFloat(activeMinutes),
            cellsExecuted: cellsCount,
            executions: executionsCount,
            hasCurrentExecution: !!session.currentExecution,
            folder: session.folder,
            dataFileExists: dataFile !== null
        });
    }

    res.json({
        totalSessions: sessions.size,
        maxSessions: MAX_SESSIONS,
        sessions: sessionData,
        memoryUsage: {
            rss: formatMemory(memUsage.rss),
            heapTotal: formatMemory(memUsage.heapTotal),
            heapUsed: formatMemory(memUsage.heapUsed),
            external: formatMemory(memUsage.external),
            arrayBuffers: formatMemory(memUsage.arrayBuffers)
        },
        totalCellsExecuted: totalCells,
        totalExecutions: totalExecutions,
        queuedExecutions: executionQueue.size,
        completedExecutions: completedExecutions.size,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.get('/debug/sessions/:sessionId', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        console.warn(`🔒 Auth failed for /debug/sessions/:sessionId`);
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found in memory' });
    }

    const sessionData = await getSessionData(sessionId);
    const memUsage = process.memoryUsage();

    res.json({
        session: {
            sessionId: sessionId,
            colabSession: session.colabSession,
            status: session.status,
            createdAt: new Date(session.createdAt).toISOString(),
            lastActivity: new Date(session.lastActivity).toISOString(),
            activeMinutes: ((Date.now() - session.createdAt) / 1000 / 60).toFixed(2),
            hasCurrentExecution: !!session.currentExecution,
            folder: session.folder
        },
        sessionData: sessionData,
        currentExecution: session.currentExecution || null,
        memoryUsage: {
            rss: formatMemory(memUsage.rss),
            heapTotal: formatMemory(memUsage.heapTotal),
            heapUsed: formatMemory(memUsage.heapUsed),
            external: formatMemory(memUsage.external),
            arrayBuffers: formatMemory(memUsage.arrayBuffers)
        },
        timestamp: new Date().toISOString()
    });
});

app.post('/start', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        console.warn(`🔒 Auth failed for /start`);
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    // Check if max sessions reached - kill oldest if needed
    if (sessions.size >= MAX_SESSIONS) {
        console.log(`🧹 ${sessions.size} sessions active, max ${MAX_SESSIONS}`);
        let oldestSessionId = null;
        let oldestTime = Infinity;
        
        for (const [sessionId, session] of sessions.entries()) {
            if (session.lastActivity < oldestTime) {
                oldestTime = session.lastActivity;
                oldestSessionId = sessionId;
            }
        }
        
        if (oldestSessionId) {
            console.log(`🗑️ Killing oldest session: ${oldestSessionId}`);
            const session = sessions.get(oldestSessionId);
            try {
                await runColabCli(['stop', '-s', session.colabSession], 10000);
            } catch (error) {
                console.log(`⚠️ Could not stop session remotely: ${error.message}`);
            }
            await cleanupSessionFolder(oldestSessionId);
            sessions.delete(oldestSessionId);
            console.log(`✅ Removed session ${oldestSessionId}`);
        }
    }

    console.log(`📝 New session request received`);
    const sessionId = generateSessionId();
    const colabSessionName = `colab_${sessionId.substring(0, 12)}`;

    try {
        await createSessionFolder(sessionId);
        
        // Create session data file immediately
        const initialData = {
            sessionId: sessionId,
            createdAt: new Date().toISOString(),
            cells: [],
            totalCells: 0,
            totalExecutions: 0,
            lastUpdated: new Date().toISOString()
        };
        const dataFile = path.join(path.join(SESSIONS_BASE_DIR, sessionId), 'session_data.json');
        await fs.writeFile(dataFile, JSON.stringify(initialData, null, 2));
        
        console.log(`⏳ Creating Colab session: ${colabSessionName}`);
        await runColabCli(['new', '--gpu', 'T4', '-s', colabSessionName], 60000);
        
        // Save session to memory
        sessions.set(sessionId, {
            colabSession: colabSessionName,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            status: 'ready',
            currentExecution: null,
            folder: path.join(SESSIONS_BASE_DIR, sessionId)
        });

        console.log(`✅ Session ${sessionId} created successfully`);
        res.json({
            success: true,
            sessionId: sessionId,
            authUrl: null,
            expiresIn: SESSION_TIMEOUT,
            activeSessions: sessions.size,
            maxSessions: MAX_SESSIONS,
            message: 'Session created successfully'
        });
    } catch (error) {
        console.error('❌ Session creation failed:', error.message);
        await cleanupSessionFolder(sessionId);
        
        // The spawn fallback with 10s timeout
        const child = spawn(COLAB_BINARY, USE_PYTHON_MODULE ? ['-m', 'colab_cli', 'new', '--gpu', 'T4', '-s', colabSessionName] : ['new', '--gpu', 'T4', '-s', colabSessionName]);
        let authUrl = null;
        let outputBuffer = '';
        const timeout = setTimeout(() => {
            if (!authUrl) {
                child.kill();
                console.error('❌ Session creation timeout - no auth URL received');
                res.status(500).json({ 
                    error: 'Failed to create session', 
                    details: 'Authentication required or token expired'
                });
            }
        }, 10000);

        const handleOutput = (data) => {
            outputBuffer += data.toString();
            const match = outputBuffer.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s]+/);
            if (match && !authUrl) {
                authUrl = match[0].split('"')[0].split("'")[0].split('\n')[0];
                clearTimeout(timeout);
                child.kill();
                console.log(`🔐 Auth URL detected: ${authUrl.substring(0, 50)}...`);
                
                // Save session to memory even if auth is needed
                sessions.set(sessionId, {
                    colabSession: colabSessionName,
                    createdAt: Date.now(),
                    lastActivity: Date.now(),
                    status: 'auth_required',
                    currentExecution: null,
                    folder: path.join(SESSIONS_BASE_DIR, sessionId),
                    authUrl: authUrl
                });
                
                res.json({
                    success: false,
                    needsAuth: true,
                    authUrl: authUrl,
                    sessionId: sessionId,
                    message: 'Please authenticate with Google'
                });
            }
        };

        child.stdout.on('data', handleOutput);
        child.stderr.on('data', handleOutput);
        child.on('error', (err) => {
            clearTimeout(timeout);
            if (!authUrl) {
                console.error('❌ Spawn error:', err.message);
                res.status(500).json({ error: 'Failed to create session', details: err.message });
            }
        });
    }
});

app.post('/keepalive', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        console.warn(`🔒 Auth failed for /keepalive`);
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        console.warn(`⚠️ Keepalive failed: session ${sessionId} not found`);
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        await runColabCli(['sessions'], 10000);
        session.lastActivity = Date.now();
        sessions.set(sessionId, session);
        console.log(`💓 Keepalive success for session ${sessionId.substring(0, 12)}...`);
        res.json({ success: true, message: 'Session kept alive' });
    } catch (error) {
        console.error(`❌ Keepalive failed for ${sessionId}:`, error.message);
        res.status(500).json({ error: 'Keepalive failed', details: error.message });
    }
});

app.post('/run', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        console.warn(`🔒 Auth failed for /run`);
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, code, cellNo } = req.body;
    if (!sessionId || !code || cellNo === undefined) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, code, cellNo' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        console.warn(`⚠️ Run failed: session ${sessionId} not found`);
        return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status === 'busy') {
        console.warn(`⚠️ Session ${sessionId} is busy with execution ${session.currentExecution?.executionId}`);
        return res.status(409).json({ 
            error: 'Session busy',
            currentExecution: session.currentExecution
        });
    }

    const executionId = crypto.randomBytes(16).toString('hex');
    const validCellNo = parseInt(cellNo, 10);

    console.log(`▶️ Starting execution ${executionId} on session ${sessionId}, cell ${validCellNo}`);
    console.log(`📝 Code length: ${code.length} chars`);

    session.status = 'busy';
    session.lastActivity = Date.now();
    session.currentExecution = {
        executionId: executionId,
        cellNo: validCellNo,
        startedAt: Date.now(),
        status: 'running',
        partialOutput: '',
        partialError: ''
    };
    sessions.set(sessionId, session);

    // Save cell start to session data
    const cellStartData = {
        type: 'execution_start',
        cellNo: validCellNo,
        startedAt: new Date().toISOString(),
        code: code,
        status: 'started'
    };
    await appendSessionData(sessionId, cellStartData);

    backgroundExecution(sessionId, validCellNo, code, executionId);

    res.json({
        status: 'processing',
        sessionId: sessionId,
        executionId: executionId,
        pollInterval: POLL_INTERVAL,
        message: 'Code execution started. Poll /status for results.'
    });
});

app.post('/status', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        console.warn(`🔒 Auth failed for /status`);
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, executionId } = req.body;
    if (!sessionId || !executionId) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, executionId' });
    }

    if (completedExecutions.has(executionId)) {
        const record = completedExecutions.get(executionId);
        return res.json({
            status: record.status,
            output: record.output,
            error: record.error,
            executionTime: record.executionTime
        });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        console.warn(`⚠️ Status check: session ${sessionId} not found`);
        return res.status(404).json({ error: 'Session not found' });
    }

    const execution = session.currentExecution;
    if (execution && execution.executionId === executionId) {
        return res.json({
            status: 'running',
            elapsed: Date.now() - execution.startedAt,
            partialOutput: execution.partialOutput || '',
            partialError: execution.partialError || ''
        });
    }

    res.json({ 
        status: 'not_found',
        message: 'Execution not found or already completed'
    });
});

app.post('/status/ack', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        console.warn(`🔒 Auth failed for /status/ack`);
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { executionId } = req.body;
    if (executionId && completedExecutions.has(executionId)) {
        completedExecutions.delete(executionId);
        console.log(`✅ Acknowledged execution ${executionId}`);
        res.json({ success: true, message: 'Acknowledged' });
    } else {
        res.json({ success: false, message: 'Execution not found' });
    }
});

app.delete('/session/:sessionId', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        console.warn(`🔒 Auth failed for DELETE /session`);
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    if (!session) {
        console.warn(`⚠️ Delete failed: session ${sessionId} not found`);
        return res.status(404).json({ error: 'Session not found' });
    }

    console.log(`🗑️ Deleting session ${sessionId}`);
    try {
        await runColabCli(['stop', '-s', session.colabSession], 30000);
        await cleanupSessionFolder(sessionId);
        sessions.delete(sessionId);
        console.log(`✅ Session ${sessionId} terminated`);
        res.json({ success: true, message: 'Session terminated' });
    } catch (error) {
        console.error(`❌ Delete error for ${sessionId}:`, error.message);
        await cleanupSessionFolder(sessionId);
        sessions.delete(sessionId);
        res.json({ 
            success: true, 
            warning: 'Session removed from tracking, but may still exist remotely' 
        });
    }
});

// ============================================
// 404 HANDLER
// ============================================

app.use((req, res) => {
    console.log(`❓ 404: ${req.method} ${req.path}`);
    res.status(404).json({
        error: 'Not Found',
        message: 'This is an API-only server. Available endpoints:',
        endpoints: {
            health: 'GET /health',
            simpleHealth: 'GET /health/simple',
            start: 'POST /start',
            keepalive: 'POST /keepalive',
            run: 'POST /run',
            status: 'POST /status',
            acknowledge: 'POST /status/ack',
            deleteSession: 'DELETE /session/:sessionId',
            debug: 'GET /debug/sessions'
        },
        timestamp: new Date().toISOString()
    });
});

// ============================================
// CLEANUP IDLE SESSIONS
// ============================================

async function cleanupIdleSessions() {
    const now = Date.now();
    let cleaned = 0;
    for (const [sessionId, session] of sessions.entries()) {
        if (now - session.lastActivity > SESSION_TIMEOUT && session.status !== 'busy') {
            console.log(`🧹 Cleaning idle session ${sessionId}`);
            try {
                await runColabCli(['stop', '-s', session.colabSession], 10000);
                await cleanupSessionFolder(sessionId);
                cleaned++;
            } catch (error) {
                console.error(`❌ Failed to clean session ${sessionId}:`, error.message);
            }
            sessions.delete(sessionId);
        }
    }
    if (cleaned > 0) {
        console.log(`🧹 Cleaned up ${cleaned} idle sessions`);
    }
    setTimeout(cleanupIdleSessions, 60 * 60 * 1000);
}

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

let shutdownInProgress = false;

async function gracefulShutdown(signal) {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    
    console.log(`🛑 Received ${signal}, starting graceful shutdown...`);
    console.log(`📊 Active sessions: ${sessions.size}, active executions: ${executionProcesses.size}`);
    
    for (const sessionId of sessions.keys()) {
        try {
            const session = sessions.get(sessionId);
            if (session) {
                console.log(`🧹 Cleaning up session ${sessionId}`);
                await runColabCli(['stop', '-s', session.colabSession], 10000);
                await cleanupSessionFolder(sessionId);
                sessions.delete(sessionId);
            }
        } catch (error) {
            console.error(`❌ Failed to clean up session ${sessionId}:`, error.message);
        }
    }
    
    console.log('✅ Graceful shutdown complete');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught exception:', error.message);
    console.error(error.stack);
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason) => {
    console.error('💥 Unhandled rejection:', reason);
});

// ============================================
// INITIALIZATION
// ============================================

async function init() {
    console.log('🚀 Initializing Colab Orchestrator v2.1...');
    
    await initColabBinary();
    await fs.mkdir(SESSIONS_BASE_DIR, { recursive: true });
    await setupColabAuth();
    
    console.log('✅ Token auto-refresh handled by Colab CLI');
    console.log(`✅ Colab binary: ${COLAB_BINARY} ${USE_PYTHON_MODULE ? '(-m colab_cli)' : ''}`);
    
    // Start cleanup after 1 hour
    setTimeout(cleanupIdleSessions, 60 * 60 * 1000);

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`\n🚀 Colab Orchestrator v2.1 running on port ${PORT}`);
        console.log(`📁 Sessions folder: ${SESSIONS_BASE_DIR}`);
        console.log(`🔧 Colab binary: ${COLAB_BINARY} ${USE_PYTHON_MODULE ? '(-m colab_cli)' : ''}`);
        console.log(`📊 Max sessions: ${MAX_SESSIONS}`);
        console.log(`🔐 API Secret: ${API_SECRET !== 'kushalkumarjthegreat' ? '✅ Custom' : '⚠️ Default'}`);
        console.log(`🔑 Colab Auth: ${process.env.COLAB_AUTH_TOKEN ? '✅ Token configured' : '⚠️ No token'}`);
        console.log(`⏰ Session timeout: ${SESSION_TIMEOUT / 1000 / 60 / 60} hours`);
        console.log(`⏱️  Execution timeout: ${EXECUTION_TIMEOUT / 60} minutes`);
        console.log(`🔒 CORS: ${allowedOrigins.length} allowed origins`);
        console.log(`📦 API-Only: No static files served`);
        console.log(`\n🌐 API server running on http://localhost:${PORT}`);
        console.log(`📊 Health check: http://localhost:${PORT}/health\n`);
    });
}

init();
