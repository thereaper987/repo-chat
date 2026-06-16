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

function generateExecutionId() {
    return crypto.randomBytes(16).toString('hex');
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

// ============================================
// HELP ENDPOINT (Public - No Auth Required)
// ============================================

/**
 * GET /help
 * Returns comprehensive API documentation for AI agents and developers.
 * This endpoint explains every available endpoint, their purpose, request/response formats,
 * authentication requirements, and provides usage examples.
 */
app.get('/help', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    res.json({
        server: {
            name: "Colab Orchestrator API",
            version: "2.1.0",
            description: "A REST API wrapper around Google Colab CLI that enables remote execution of Python code on Colab VMs",
            baseUrl: baseUrl,
            documentation: "This help endpoint provides complete API documentation for AI agents and developers"
        },
        authentication: {
            description: "Most endpoints require an API secret for authentication. The secret can be sent in multiple ways:",
            methods: [
                {
                    method: "Request Body",
                    description: "Include 'api_secret' in the JSON body of POST requests",
                    example: '{"api_secret": "your-secret", ...otherFields}'
                },
                {
                    method: "HTTP Header",
                    description: "Send 'api-secret' header with the secret value",
                    example: "api-secret: your-secret"
                },
                {
                    method: "HTTP Header (Alternative)",
                    description: "Send 'x-api-secret' header with the secret value",
                    example: "x-api-secret: your-secret"
                }
            ],
            publicEndpoints: [
                "GET /health",
                "GET /health/simple",
                "GET /help",
                "GET /sessions",
                "GET /sessions/:identifier"
            ],
            note: "The default API secret is 'your-api-key'. It is recommended to change this in production."
        },
        endpoints: {
            health: {
                method: "GET",
                path: "/health",
                authRequired: false,
                purpose: "Full health check - Returns detailed server status, memory usage, active sessions, and Colab CLI configuration",
                request: {
                    format: "No request body required",
                    headers: "None required"
                },
                response: {
                    format: "JSON",
                    fields: {
                        status: "Always 'healthy' if server is running",
                        activeSessions: "Number of active Colab sessions",
                        maxSessions: "Maximum sessions allowed (configurable)",
                        sessionDetails: "Array of session objects with truncated IDs",
                        completedExecutions: "Number of completed executions in memory",
                        queuedExecutions: "Number of executions waiting to run",
                        uptime: "Server uptime in seconds",
                        memoryUsage: "Memory usage breakdown (RSS, heapTotal, heapUsed, external, arrayBuffers)",
                        timestamp: "Current server time in ISO format",
                        colabBinary: "Path to Colab CLI binary being used",
                        usePythonModule: "Whether Python module is being used instead of binary",
                        hasAuthToken: "Whether COLAB_AUTH_TOKEN is configured"
                    },
                    example: {
                        status: "healthy",
                        activeSessions: 1,
                        maxSessions: 3,
                        sessionDetails: [
                            {
                                id: "a1b2c3d4e5f6...",
                                colabSession: "colab_a1b2c3d4e5f6",
                                createdAt: "2026-06-17T00:00:00.000Z",
                                lastActivity: "2026-06-17T00:05:00.000Z",
                                status: "ready",
                                hasCurrentExecution: false
                            }
                        ],
                        completedExecutions: 5,
                        queuedExecutions: 0,
                        uptime: 3600,
                        memoryUsage: {
                            rss: "56.78 MB",
                            heapTotal: "34.56 MB",
                            heapUsed: "23.45 MB",
                            external: "5.67 MB",
                            arrayBuffers: "1.23 MB"
                        },
                        timestamp: "2026-06-17T00:00:00.000Z",
                        colabBinary: "/usr/bin/colab",
                        usePythonModule: false,
                        hasAuthToken: true
                    }
                },
                usage: {
                    curl: `curl ${baseUrl}/health`,
                    javascript: `fetch('${baseUrl}/health').then(r => r.json()).then(console.log);`,
                    python: `import requests; print(requests.get('${baseUrl}/health').json())`
                }
            },
            healthSimple: {
                method: "GET",
                path: "/health/simple",
                authRequired: false,
                purpose: "Simple health check - Quick ping to verify server is alive",
                request: {
                    format: "No request body required",
                    headers: "None required"
                },
                response: {
                    format: "JSON",
                    fields: {
                        status: "Always 'up' if server is running",
                        timestamp: "Current server time in ISO format",
                        sessions: "Number of active sessions"
                    },
                    example: {
                        status: "up",
                        timestamp: "2026-06-17T00:00:00.000Z",
                        sessions: 1
                    }
                },
                usage: {
                    curl: `curl ${baseUrl}/health/simple`,
                    javascript: `fetch('${baseUrl}/health/simple').then(r => r.json()).then(console.log);`,
                    python: `import requests; print(requests.get('${baseUrl}/health/simple').json())`
                }
            },
            help: {
                method: "GET",
                path: "/help",
                authRequired: false,
                purpose: "Returns this complete API documentation for AI agents and developers",
                request: {
                    format: "No request body required",
                    headers: "None required"
                },
                response: {
                    format: "JSON",
                    description: "This entire documentation structure",
                    fields: "See this response for complete structure"
                },
                usage: {
                    curl: `curl ${baseUrl}/help`,
                    javascript: `fetch('${baseUrl}/help').then(r => r.json()).then(console.log);`,
                    python: `import requests; print(requests.get('${baseUrl}/help').json())`
                }
            },
            sessions: {
                method: "GET",
                path: "/sessions",
                authRequired: false,
                purpose: "List all active sessions with their details and execution history",
                request: {
                    format: "No request body required",
                    headers: "None required"
                },
                response: {
                    format: "JSON",
                    fields: {
                        totalSessions: "Total number of active sessions",
                        maxSessions: "Maximum sessions allowed",
                        sessions: "Array of session objects",
                        sessions_sub: "Short identifier (first 8 chars of sessionId)",
                        sessions_sessionId: "Full 32-character hex session ID",
                        sessions_colabSession: "Internal Colab session name",
                        sessions_status: "Session status: 'ready', 'busy', or 'auth_required'",
                        sessions_createdAt: "Session creation timestamp",
                        sessions_lastActivity: "Last activity timestamp",
                        sessions_activeMinutes: "Session age in minutes",
                        sessions_cellsExecuted: "Number of cells executed",
                        sessions_executions: "Number of executions",
                        sessions_hasCurrentExecution: "Whether a code execution is running",
                        sessions_folder: "Session folder path on server",
                        sessions_dataFileExists: "Whether session data file exists",
                        memoryUsage: "Current memory usage breakdown",
                        totalCellsExecuted: "Total cells executed across all sessions",
                        totalExecutions: "Total executions across all sessions",
                        queuedExecutions: "Number of queued executions",
                        completedExecutions: "Number of completed executions in memory",
                        uptime: "Server uptime in seconds",
                        timestamp: "Current server time"
                    },
                    example: {
                        totalSessions: 1,
                        maxSessions: 3,
                        sessions: [
                            {
                                sub: "a1b2c3d4",
                                sessionId: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
                                colabSession: "colab_a1b2c3d4e5f6",
                                status: "ready",
                                createdAt: "2026-06-17T00:00:00.000Z",
                                lastActivity: "2026-06-17T00:05:00.000Z",
                                activeMinutes: 5.00,
                                cellsExecuted: 3,
                                executions: 3,
                                hasCurrentExecution: false,
                                folder: "/tmp/colab_sessions/a1b2c3d4...",
                                dataFileExists: true
                            }
                        ],
                        memoryUsage: { rss: "56.78 MB", heapTotal: "34.56 MB", heapUsed: "23.45 MB" },
                        totalCellsExecuted: 3,
                        totalExecutions: 3,
                        queuedExecutions: 0,
                        completedExecutions: 5,
                        uptime: 3600,
                        timestamp: "2026-06-17T00:00:00.000Z"
                    }
                },
                usage: {
                    curl: `curl ${baseUrl}/sessions`,
                    javascript: `fetch('${baseUrl}/sessions').then(r => r.json()).then(console.log);`,
                    python: `import requests; print(requests.get('${baseUrl}/sessions').json())`
                }
            },
            sessionDetails: {
                method: "GET",
                path: "/sessions/:identifier",
                authRequired: false,
                purpose: "Get detailed information about a specific session",
                request: {
                    format: "URL parameter",
                    parameters: {
                        identifier: "Session ID (full 32-char hex) OR sub (first 8 chars). E.g., /sessions/a1b2c3d4 or /sessions/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"
                    },
                    headers: "None required",
                    example: `${baseUrl}/sessions/a1b2c3d4`
                },
                response: {
                    format: "JSON",
                    fields: {
                        session: "Session metadata object",
                        session_sub: "Short identifier (first 8 chars)",
                        session_sessionId: "Full session ID",
                        session_colabSession: "Colab session name",
                        session_status: "Current status",
                        session_createdAt: "Creation timestamp",
                        session_lastActivity: "Last activity timestamp",
                        session_activeMinutes: "Session age in minutes",
                        session_hasCurrentExecution: "Whether execution is running",
                        session_folder: "Session folder path",
                        sessionData: "Detailed execution history",
                        sessionData_cells: "Array of executed cells with code and outputs",
                        sessionData_totalCells: "Total cells count",
                        sessionData_totalExecutions: "Total executions count",
                        sessionData_lastUpdated: "Last update timestamp",
                        currentExecution: "Currently running execution info (or null)",
                        currentExecution_executionId: "Execution ID",
                        currentExecution_cellNo: "Cell number being executed",
                        currentExecution_startedAt: "Start timestamp",
                        currentExecution_status: "Execution status",
                        currentExecution_partialOutput: "Partial output so far",
                        currentExecution_partialError: "Partial error output so far",
                        memoryUsage: "Memory usage breakdown",
                        timestamp: "Current server time"
                    },
                    error: {
                        status: 404,
                        body: { error: "Session not found", message: "No session found with identifier: ..." }
                    },
                    example: {
                        session: {
                            sub: "a1b2c3d4",
                            sessionId: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
                            colabSession: "colab_a1b2c3d4e5f6",
                            status: "ready",
                            createdAt: "2026-06-17T00:00:00.000Z",
                            lastActivity: "2026-06-17T00:05:00.000Z",
                            activeMinutes: "5.00",
                            hasCurrentExecution: false,
                            folder: "/tmp/colab_sessions/a1b2c3d4..."
                        },
                        sessionData: {
                            sessionId: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
                            createdAt: "2026-06-17T00:00:00.000Z",
                            cells: [
                                {
                                    type: "execution",
                                    cellNo: 1,
                                    startedAt: "2026-06-17T00:01:00.000Z",
                                    code: "print('Hello World')",
                                    status: "completed",
                                    completedAt: "2026-06-17T00:01:02.000Z",
                                    executionTime: 2000,
                                    output: "Hello World\n",
                                    error: ""
                                }
                            ],
                            totalCells: 1,
                            totalExecutions: 1,
                            lastUpdated: "2026-06-17T00:05:00.000Z"
                        },
                        currentExecution: null,
                        memoryUsage: { rss: "56.78 MB", heapTotal: "34.56 MB", heapUsed: "23.45 MB" },
                        timestamp: "2026-06-17T00:00:00.000Z"
                    }
                },
                usage: {
                    curl: `curl ${baseUrl}/sessions/a1b2c3d4`,
                    javascript: `fetch('${baseUrl}/sessions/a1b2c3d4').then(r => r.json()).then(console.log);`,
                    python: `import requests; print(requests.get('${baseUrl}/sessions/a1b2c3d4').json())`
                }
            },
            startSession: {
                method: "POST",
                path: "/start",
                authRequired: true,
                purpose: "Create a new Colab session (allocates a VM with GPU T4)",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        sessionName: "Optional custom session name (auto-generated if omitted)"
                    },
                    example: {
                        api_secret: "your-api-key"
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        sessionId: "32-character hex session ID",
                        authUrl: "null (if no auth needed)",
                        expiresIn: "Session timeout in milliseconds",
                        activeSessions: "Current session count",
                        maxSessions: "Maximum allowed sessions",
                        message: "Session created successfully"
                    },
                    needsAuth: {
                        success: false,
                        needsAuth: true,
                        authUrl: "Google OAuth URL to authenticate",
                        sessionId: "32-character hex session ID",
                        message: "Please authenticate with Google"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    example: {
                        success: true,
                        sessionId: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
                        authUrl: null,
                        expiresIn: 10800000,
                        activeSessions: 1,
                        maxSessions: 3,
                        message: "Session created successfully"
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/start -H "Content-Type: application/json" -d '{"api_secret":"your-api-key"}'`,
                    javascript: `fetch('${baseUrl}/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_secret: 'your-api-key' }) }).then(r => r.json()).then(console.log);`,
                    python: `import requests; print(requests.post('${baseUrl}/start', json={'api_secret':'your-api-key'}).json())`
                }
            },
            keepAlive: {
                method: "POST",
                path: "/keepalive",
                authRequired: true,
                purpose: "Keep a session alive to prevent idle timeout (default 3 hours)",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        sessionId: "Session ID to keep alive (required)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        message: "Session kept alive"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    },
                    example: {
                        success: true,
                        message: "Session kept alive"
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/keepalive -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","sessionId":"a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"}'`,
                    javascript: `fetch('${baseUrl}/keepalive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_secret: 'your-api-key', sessionId: 'a1b2c3d4...' }) }).then(r => r.json()).then(console.log);`
                },
                recommendedInterval: "Call every 30-60 minutes to prevent session expiration"
            },
            runCode: {
                method: "POST",
                path: "/run",
                authRequired: true,
                purpose: "Execute Python code on a Colab session",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        sessionId: "Session ID to execute on (required)",
                        code: "Python code to execute (required)",
                        cellNo: "Cell number for tracking (required, integer)"
                    },
                    limits: {
                        maxCodeSize: "3 MB",
                        maxExecutionTime: "2 hours"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
                        code: "print('Hello World')",
                        cellNo: 1
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        status: "processing",
                        sessionId: "Session ID",
                        executionId: "Execution ID for polling",
                        pollInterval: "Polling interval in milliseconds",
                        message: "Code execution started. Poll /status for results."
                    },
                    busy: {
                        status: 409,
                        body: {
                            error: "Session busy",
                            currentExecution: {
                                executionId: "Current execution ID",
                                cellNo: "Current cell number",
                                startedAt: "Start timestamp",
                                status: "running",
                                partialOutput: "Partial output so far",
                                partialError: "Partial error output"
                            }
                        }
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    },
                    example: {
                        status: "processing",
                        sessionId: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
                        executionId: "f1e2d3c4b5a6",
                        pollInterval: 15000,
                        message: "Code execution started. Poll /status for results."
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/run -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","sessionId":"a1b2c3d4...","code":"print(\\"Hello World\\")","cellNo":1}'`,
                    javascript: `fetch('${baseUrl}/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_secret: 'your-api-key', sessionId: 'a1b2c3d4...', code: 'print("Hello World")', cellNo: 1 }) }).then(r => r.json()).then(console.log);`
                }
            },
            status: {
                method: "POST",
                path: "/status",
                authRequired: true,
                purpose: "Check the status of a running execution",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        sessionId: "Session ID (required)",
                        executionId: "Execution ID from /run response (required)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
                        executionId: "f1e2d3c4b5a6"
                    }
                },
                response: {
                    format: "JSON",
                    running: {
                        status: "running",
                        elapsed: "Time elapsed in milliseconds",
                        partialOutput: "Partial stdout output",
                        partialError: "Partial stderr output"
                    },
                    completed: {
                        status: "completed",
                        output: "Full stdout output",
                        error: "Full stderr output or empty",
                        executionTime: "Total execution time in milliseconds"
                    },
                    failed: {
                        status: "failed",
                        output: "Partial stdout output",
                        error: "Error message",
                        executionTime: "Total execution time in milliseconds"
                    },
                    notFound: {
                        status: "not_found",
                        message: "Execution not found or already completed"
                    },
                    example: {
                        status: "completed",
                        output: "Hello World\n",
                        error: "",
                        executionTime: 1234
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/status -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","sessionId":"a1b2c3d4...","executionId":"f1e2d3c4b5a6"}'`,
                    javascript: `fetch('${baseUrl}/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_secret: 'your-api-key', sessionId: 'a1b2c3d4...', executionId: 'f1e2d3c4b5a6' }) }).then(r => r.json()).then(console.log);`
                },
                polling: {
                    description: "Poll this endpoint every 15 seconds (or use the pollInterval from /run response) until status is 'completed' or 'failed'",
                    example: "while (status.status === 'running') { await sleep(pollInterval); status = await fetchStatus(); }"
                }
            },
            acknowledge: {
                method: "POST",
                path: "/status/ack",
                authRequired: true,
                purpose: "Acknowledge execution completion to free memory on server",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        executionId: "Execution ID to acknowledge (required)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        executionId: "f1e2d3c4b5a6"
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        message: "Acknowledged"
                    },
                    notFound: {
                        success: false,
                        message: "Execution not found"
                    },
                    example: {
                        success: true,
                        message: "Acknowledged"
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/status/ack -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","executionId":"f1e2d3c4b5a6"}'`,
                    javascript: `fetch('${baseUrl}/status/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_secret: 'your-api-key', executionId: 'f1e2d3c4b5a6' }) }).then(r => r.json()).then(console.log);`
                },
                note: "Always call this after receiving a 'completed' or 'failed' status to clean up memory"
            },
            deleteSession: {
                method: "DELETE",
                path: "/session/:sessionId",
                authRequired: true,
                purpose: "Terminate a session and release the Colab VM",
                request: {
                    format: "URL parameter + headers",
                    headers: {
                        "api-secret": "Your API secret (required)"
                    },
                    parameters: {
                        sessionId: "Session ID to delete (in URL path)"
                    },
                    example: `DELETE ${baseUrl}/session/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6`
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        message: "Session terminated"
                    },
                    warning: {
                        success: true,
                        warning: "Session removed from tracking, but may still exist remotely"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    },
                    example: {
                        success: true,
                        message: "Session terminated"
                    }
                },
                usage: {
                    curl: `curl -X DELETE ${baseUrl}/session/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6 -H "api-secret: your-api-key"`,
                    javascript: `fetch('${baseUrl}/session/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6', { method: 'DELETE', headers: { 'api-secret': 'your-api-key' } }).then(r => r.json()).then(console.log);`
                }
            }
        },
        workflow: {
            title: "Typical API Workflow",
            steps: [
                {
                    step: 1,
                    action: "Create a session",
                    endpoint: "POST /start",
                    description: "Allocate a Colab VM",
                    next: "Get sessionId from response"
                },
                {
                    step: 2,
                    action: "Keep session alive",
                    endpoint: "POST /keepalive",
                    description: "Prevent idle timeout (call every 30-60 minutes)",
                    next: "Continue until ready to execute"
                },
                {
                    step: 3,
                    action: "Execute code",
                    endpoint: "POST /run",
                    description: "Run Python code on the session",
                    next: "Get executionId from response"
                },
                {
                    step: 4,
                    action: "Poll for status",
                    endpoint: "POST /status",
                    description: "Check execution progress (every 15 seconds)",
                    next: "Wait for 'completed' or 'failed' status"
                },
                {
                    step: 5,
                    action: "Acknowledge completion",
                    endpoint: "POST /status/ack",
                    description: "Free memory on server",
                    next: "Continue or delete session"
                },
                {
                    step: 6,
                    action: "Delete session",
                    endpoint: "DELETE /session/:sessionId",
                    description: "Terminate VM and free resources",
                    next: "Done"
                }
            ],
            diagram: `
                ┌─────────────┐
                │ 1. /start   │ → Get sessionId
                └──────┬──────┘
                       ↓
                ┌─────────────┐
                │ 2. /keepalive│ → Keep alive (every 30-60 min)
                └──────┬──────┘
                       ↓
                ┌─────────────┐
                │ 3. /run     │ → Get executionId
                └──────┬──────┘
                       ↓
                ┌─────────────┐
                │ 4. /status  │ → Poll until completed
                └──────┬──────┘
                       ↓
                ┌─────────────┐
                │ 5. /status/ack│ → Acknowledge
                └──────┬──────┘
                       ↓
                ┌─────────────┐
                │ 6. DELETE   │ → Clean up
                └─────────────┘
            `
        },
        errors: {
            commonErrors: [
                {
                    code: 401,
                    description: "Invalid API secret",
                    solution: "Check that you're sending the correct API secret in the request body or headers"
                },
                {
                    code: 404,
                    description: "Session not found",
                    solution: "The session ID may be expired or invalid. Create a new session with /start"
                },
                {
                    code: 409,
                    description: "Session busy",
                    solution: "Wait for the current execution to complete, or use a different session"
                },
                {
                    code: 400,
                    description: "Missing required fields",
                    solution: "Check that all required fields are included in the request body"
                },
                {
                    code: 500,
                    description: "Internal server error",
                    solution: "Check server logs for details. The Colab CLI may have failed."
                }
            ]
        },
        limits: {
            maxSessions: MAX_SESSIONS,
            sessionTimeout: `${SESSION_TIMEOUT / 1000 / 60 / 60} hours`,
            executionTimeout: `${EXECUTION_TIMEOUT / 60} minutes`,
            maxCodeSize: `${MAX_CODE_SIZE / 1024 / 1024} MB`,
            pollingInterval: `${POLL_INTERVAL / 1000} seconds`
        },
        environmentVariables: {
            API_SECRET: "Your API secret for authentication",
            COLAB_AUTH_TOKEN: "Google Colab authentication token (JSON format)",
            MAX_SESSIONS: "Maximum concurrent sessions (default: 3)",
            SESSION_TIMEOUT: "Session timeout in milliseconds (default: 3 hours)",
            EXECUTION_TIMEOUT: "Execution timeout in seconds (default: 2 hours)",
            PORT: "Server port (default: 3000)",
            SESSIONS_BASE_DIR: "Session storage directory (default: /tmp/colab_sessions)"
        },
        timestamp: new Date().toISOString()
    });
});

// ============================================
// PUBLIC HEALTH ENDPOINTS
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
// SESSION ENDPOINTS (Public - No Auth Required)
// ============================================

// GET /sessions - List all sessions (public)
app.get('/sessions', async (req, res) => {
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
            sub: id.substring(0, 8),
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

// GET /sessions/:identifier - Get session details by sub or full sessionId (public)
app.get('/sessions/:identifier', async (req, res) => {
    const { identifier } = req.params;
    // Remove trailing slash if present (e.g., /sessions/a/ → /sessions/a)
    const cleanIdentifier = identifier.replace(/\/$/, '');
    
    let session = null;
    let sessionId = null;
    
    // Try to find by sub (first 8 chars) or full sessionId
    for (const [id, s] of sessions.entries()) {
        const sub = id.substring(0, 8);
        if (id === cleanIdentifier || sub === cleanIdentifier) {
            session = s;
            sessionId = id;
            break;
        }
    }
    
    if (!session) {
        return res.status(404).json({ 
            error: 'Session not found',
            message: `No session found with identifier: ${cleanIdentifier}`
        });
    }

    const sessionData = await getSessionData(sessionId);
    const memUsage = process.memoryUsage();

    res.json({
        session: {
            sub: sessionId.substring(0, 8),
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

// Keep the old debug endpoints for backward compatibility (but mark them deprecated)
app.get('/debug/sessions', async (req, res) => {
    console.warn('⚠️ /debug/sessions is deprecated, use /sessions instead');
    // Redirect to new endpoint
    return res.redirect('/sessions');
});

app.get('/debug/sessions/:sessionId', async (req, res) => {
    console.warn('⚠️ /debug/sessions/:sessionId is deprecated, use /sessions/:sessionId instead');
    // Redirect to new endpoint
    return res.redirect(`/sessions/${req.params.sessionId}`);
});

// ============================================
// PROTECTED ENDPOINTS (Auth Required)
// ============================================

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
            help: 'GET /help',
            sessions: 'GET /sessions',
            sessionDetails: 'GET /sessions/:identifier',
            start: 'POST /start',
            keepalive: 'POST /keepalive',
            run: 'POST /run',
            status: 'POST /status',
            acknowledge: 'POST /status/ack',
            deleteSession: 'DELETE /session/:sessionId'
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
        console.log(`🔐 API Secret: ${API_SECRET}`);
        console.log(`🔑 Colab Auth: ${process.env.COLAB_AUTH_TOKEN ? '✅ Token configured' : '⚠️ No token'}`);
        console.log(`⏰ Session timeout: ${SESSION_TIMEOUT / 1000 / 60 / 60} hours`);
        console.log(`⏱️  Execution timeout: ${EXECUTION_TIMEOUT / 60} minutes`);
        console.log(`🔒 CORS: ${allowedOrigins.length} allowed origins`);
        console.log(`📦 API-Only: No static files served`);
        console.log(`\n🌐 API server running on http://localhost:${PORT}`);
        console.log(`📊 Health check: http://localhost:${PORT}/health`);
        console.log(`📖 Help: http://localhost:${PORT}/help\n`);
    });
}

init();
