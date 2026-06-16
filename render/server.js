// ============================================
// IMPROVED SERVER.JS - v2.0 (API-Only)
// No Static File Serving - Backend Only
// Optimized for Single User, 3 Frontend Apps
// ============================================

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
// CONFIGURATION MANAGEMENT
// ============================================

class Config {
    constructor() {
        this.API_SECRET = process.env.API_SECRET || 'kushalkumarjthegreat';
        this.MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS) || 3;
        this.SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT) || 3 * 60 * 60 * 1000;
        this.EXECUTION_TIMEOUT = parseInt(process.env.EXECUTION_TIMEOUT) || 7200;
        this.MAX_CODE_SIZE = parseInt(process.env.MAX_CODE_SIZE) || 3 * 1024 * 1024;
        this.COMPLETED_EXECUTIONS_TTL = parseInt(process.env.COMPLETED_EXECUTIONS_TTL) || 10 * 60 * 1000;
        this.POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL) || 15000;
        this.MAX_CODE_LENGTH = parseInt(process.env.MAX_CODE_LENGTH) || 100000;
        this.SESSIONS_BASE_DIR = process.env.SESSIONS_BASE_DIR || path.join(os.tmpdir(), 'colab_sessions');
        this.COLAB_AUTH_TOKEN = process.env.COLAB_AUTH_TOKEN;
        this.PORT = process.env.PORT || 3000;
        this.NODE_ENV = process.env.NODE_ENV || 'development';
        this.LOG_LEVEL = process.env.LOG_LEVEL || 'info';
    }

    validate() {
        const errors = [];
        if (!this.API_SECRET || this.API_SECRET.length < 8) {
            errors.push('API_SECRET must be at least 8 characters');
        }
        if (this.MAX_SESSIONS < 1) {
            errors.push('MAX_SESSIONS must be at least 1');
        }
        if (this.EXECUTION_TIMEOUT < 60) {
            errors.push('EXECUTION_TIMEOUT must be at least 60 seconds');
        }
        if (errors.length > 0) {
            throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
        }
        return true;
    }
}

const CONFIG = new Config();

// ============================================
// SIMPLE LOGGER
// ============================================

class Logger {
    constructor(level = 'info') {
        this.levels = { error: 0, warn: 1, info: 2, debug: 3 };
        this.level = this.levels[level] ?? 2;
        this.colors = {
            error: '\x1b[31m',
            warn: '\x1b[33m',
            info: '\x1b[36m',
            debug: '\x1b[35m',
            reset: '\x1b[0m'
        };
    }

    _format(level, message, meta = {}) {
        const timestamp = new Date().toISOString();
        const color = this.colors[level] || '';
        const reset = this.colors.reset;
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} ${color}[${level.toUpperCase()}]${reset} ${message}${metaStr}`;
    }

    error(message, meta) {
        if (this.level >= this.levels.error) console.error(this._format('error', message, meta));
    }
    warn(message, meta) {
        if (this.level >= this.levels.warn) console.warn(this._format('warn', message, meta));
    }
    info(message, meta) {
        if (this.level >= this.levels.info) console.log(this._format('info', message, meta));
    }
    debug(message, meta) {
        if (this.level >= this.levels.debug) console.log(this._format('debug', message, meta));
    }
}

const logger = new Logger(CONFIG.LOG_LEVEL);

// ============================================
// CORS CONFIGURATION
// ============================================

const allowedOrigins = [
    'https://kushalkumarj2006.github.io',
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
        logger.warn(`CORS blocked: ${origin}`);
        return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'api-secret', 'x-api-secret', 'Authorization'],
    exposedHeaders: ['Content-Type', 'api-secret'],
    credentials: true,
    maxAge: 86400
};

// ============================================
// HELPERS
// ============================================

function validateApiSecret(input) {
    return input === CONFIG.API_SECRET;
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
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function detectExitCode(output) {
    const systemExitMatch = output.match(/SystemExit:\s*(\d+)/);
    if (systemExitMatch) {
        return parseInt(systemExitMatch[1]);
    }
    if (output.includes('Traceback') || output.includes('Error:')) {
        return 1;
    }
    return 0;
}

// ============================================
// COLAB BINARY MANAGER
// ============================================

class ColabBinaryManager {
    constructor() {
        this.binary = 'colab';
        this.usePythonModule = false;
        this.isInitialized = false;
        this.binaryCache = null;
        this.cacheTTL = 3600000; // 1 hour
    }

    async findBinary() {
        logger.info('Searching for colab binary...');
        
        if (this.binaryCache && (Date.now() - this.binaryCache.timestamp) < this.cacheTTL) {
            logger.debug('Using cached binary location', { path: this.binaryCache.path });
            return this.binaryCache.path;
        }

        const searchMethods = [
            () => this._whichColab(),
            () => this._findPipModule(),
            () => this._searchCommonPaths(),
            () => this._checkPythonModule()
        ];

        for (const method of searchMethods) {
            try {
                const result = await method();
                if (result) {
                    this.binaryCache = { path: result, timestamp: Date.now() };
                    return result;
                }
            } catch (error) {
                logger.debug(`Binary search method failed: ${error.message}`);
            }
        }

        logger.warn('Colab binary not found, defaulting to python3 module');
        return 'python3';
    }

    async _whichColab() {
        const { stdout } = await execPromise('which colab 2>/dev/null || echo ""', { timeout: 5000 });
        const path = stdout.trim();
        if (path) {
            logger.info(`Found colab via which: ${path}`);
            return path;
        }
        return null;
    }

    async _findPipModule() {
        try {
            const { stdout } = await execPromise(
                'pip3 show google-colab-cli 2>/dev/null | grep Location | cut -d" " -f2',
                { timeout: 5000 }
            );
            const location = stdout.trim();
            if (location) {
                const binaryPath = path.join(location, 'colab_cli/__main__.py');
                try {
                    await fs.access(binaryPath);
                    logger.info(`Found colab via pip: ${binaryPath}`);
                    return 'python3';
                } catch {}
            }
        } catch {}
        return null;
    }

    async _searchCommonPaths() {
        const paths = [
            '/opt/render/.local/bin',
            '/usr/local/bin',
            '/usr/bin',
            '/opt/render/project/.local/bin',
            '/home/render/.local/bin',
            '/opt/render/project/src/.local/bin'
        ];

        for (const searchPath of paths) {
            try {
                const { stdout } = await execPromise(
                    `find ${searchPath} -name "colab" -type f 2>/dev/null | head -1`,
                    { timeout: 5000 }
                );
                const result = stdout.trim();
                if (result) {
                    await execPromise(`chmod +x "${result}" 2>/dev/null || true`);
                    logger.info(`Found colab via search: ${result}`);
                    return result;
                }
            } catch {}
        }
        return null;
    }

    async _checkPythonModule() {
        try {
            await execPromise('python3 -c "import colab_cli" 2>/dev/null', { timeout: 5000 });
            logger.info('Found colab as Python module');
            return 'python3';
        } catch {
            return null;
        }
    }

    async initialize() {
        if (this.isInitialized) return;
        
        const binary = await this.findBinary();
        if (binary === 'python3') {
            this.usePythonModule = true;
            this.binary = 'python3';
            logger.info(`Using Python module: ${this.binary} -m colab_cli`);
        } else {
            this.binary = binary;
            this.usePythonModule = false;
            logger.info(`Using colab binary: ${this.binary}`);
        }
        this.isInitialized = true;
    }

    async run(args, timeout = 30000) {
        if (!this.isInitialized) await this.initialize();

        return new Promise((resolve, reject) => {
            let command;
            if (this.usePythonModule) {
                const escapedArgs = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
                command = `python3 -m colab_cli ${escapedArgs}`;
            } else {
                const escapedArgs = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
                command = `${this.binary} ${escapedArgs}`;
            }
            
            logger.debug(`Running: ${command.substring(0, 200)}`);
            
            exec(command, { 
                timeout, 
                shell: '/bin/bash', 
                maxBuffer: 50 * 1024 * 1024,
                env: { ...process.env, PYTHONUNBUFFERED: '1' }
            }, (error, stdout, stderr) => {
                if (error && error.code !== 0) {
                    reject({ error, stdout, stderr, code: error.code });
                } else {
                    resolve({ stdout, stderr });
                }
            });
        });
    }

    async runWithStreaming(args, timeout = 30000) {
        if (!this.isInitialized) await this.initialize();

        let command, cmdArgs;
        if (this.usePythonModule) {
            command = 'python3';
            cmdArgs = ['-m', 'colab_cli', ...args];
        } else {
            command = this.binary;
            cmdArgs = args;
        }

        return spawn(command, cmdArgs, {
            shell: true,
            timeout: timeout * 1000,
            env: { ...process.env, PYTHONUNBUFFERED: '1' }
        });
    }

    async testConnection() {
        try {
            const { stdout } = await this.run(['--version'], 10000);
            logger.info('Colab CLI connection test successful', { version: stdout.trim() });
            return true;
        } catch (error) {
            logger.error('Colab CLI connection test failed', { error: error.message });
            return false;
        }
    }
}

// ============================================
// AUTH SETUP
// ============================================

async function setupColabAuth() {
    if (!CONFIG.COLAB_AUTH_TOKEN) {
        logger.warn('COLAB_AUTH_TOKEN not found in environment');
        return false;
    }

    try {
        let rawToken = CONFIG.COLAB_AUTH_TOKEN.trim();
        if ((rawToken.startsWith("'") && rawToken.endsWith("'")) || 
            (rawToken.startsWith('"') && rawToken.endsWith('"'))) {
            rawToken = rawToken.slice(1, -1);
        }

        const tokenData = JSON.parse(rawToken);
        if (!tokenData.access_token) {
            throw new Error('Invalid token: missing access_token');
        }
        
        logger.info('Parsed COLAB_AUTH_TOKEN successfully');
        
        const configDir = path.join(os.homedir(), '.config/colab-cli');
        await fs.mkdir(configDir, { recursive: true });
        
        await fs.writeFile(
            path.join(configDir, 'token.json'), 
            JSON.stringify(tokenData, null, 2)
        );
        logger.info('Written token.json');

        await fs.writeFile(
            path.join(configDir, 'sessions.json'), 
            JSON.stringify({})
        );
        logger.info('Written sessions.json');
        
        return true;
    } catch (error) {
        logger.error('Auth setup failed:', { error: error.message });
        return false;
    }
}

// ============================================
// SESSION MANAGER
// ============================================

class SessionManager {
    constructor(baseDir) {
        this.baseDir = baseDir;
        this.sessions = new Map();
        this.completedExecutions = new Map();
        this.activeExecutions = new Map();
        this.executionQueue = new Set();
        this.sessionDataCache = new Map();
        this.cacheTTL = 60000;
    }

    async createSessionFolder(sessionId) {
        const sessionFolder = path.join(this.baseDir, sessionId);
        await fs.mkdir(sessionFolder, { recursive: true });
        return sessionFolder;
    }

    async cleanupSessionFolder(sessionId) {
        const sessionFolder = path.join(this.baseDir, sessionId);
        try {
            await fs.rm(sessionFolder, { recursive: true, force: true });
            logger.info(`Cleaned up folder for session ${sessionId}`);
            this.sessionDataCache.delete(sessionId);
        } catch (error) {
            logger.error(`Failed to cleanup folder for ${sessionId}:`, { error: error.message });
        }
    }

    async appendSessionData(sessionId, data) {
        const sessionFolder = path.join(this.baseDir, sessionId);
        const dataFile = path.join(sessionFolder, 'session_data.json');
        
        try {
            let sessionData = {};
            try {
                const content = await fs.readFile(dataFile, 'utf8');
                sessionData = JSON.parse(content);
            } catch {
                sessionData = {
                    sessionId: sessionId,
                    createdAt: new Date().toISOString(),
                    cells: [],
                    totalCells: 0,
                    totalExecutions: 0,
                    metadata: { version: '2.0' }
                };
            }
            
            sessionData.cells.push(data);
            sessionData.totalCells = sessionData.cells.length;
            sessionData.totalExecutions = sessionData.cells.filter(c => c.type === 'execution').length;
            sessionData.lastUpdated = new Date().toISOString();
            
            await fs.writeFile(dataFile, JSON.stringify(sessionData, null, 2));
            this.sessionDataCache.set(sessionId, { data: sessionData, timestamp: Date.now() });
            return sessionData;
        } catch (error) {
            logger.error(`Failed to append session data for ${sessionId}:`, { error: error.message });
            return null;
        }
    }

    async getSessionData(sessionId) {
        const cached = this.sessionDataCache.get(sessionId);
        if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
            return cached.data;
        }

        const sessionFolder = path.join(this.baseDir, sessionId);
        const dataFile = path.join(sessionFolder, 'session_data.json');
        
        try {
            const content = await fs.readFile(dataFile, 'utf8');
            const data = JSON.parse(content);
            this.sessionDataCache.set(sessionId, { data, timestamp: Date.now() });
            return data;
        } catch {
            return null;
        }
    }

    startCleanupInterval() {
        setInterval(() => {
            const now = Date.now();
            for (const [execId, data] of this.completedExecutions.entries()) {
                if (now - data.completedAt > CONFIG.COMPLETED_EXECUTIONS_TTL) {
                    this.completedExecutions.delete(execId);
                }
            }
        }, 60000);
    }

    async cleanupIdleSessions(colab) {
        const now = Date.now();
        let cleaned = 0;
        
        for (const [sessionId, session] of this.sessions.entries()) {
            if (now - session.lastActivity > CONFIG.SESSION_TIMEOUT && session.status !== 'busy') {
                try {
                    await colab.run(['stop', '-s', session.colabSession], 10000);
                    await this.cleanupSessionFolder(sessionId);
                    cleaned++;
                } catch (error) {
                    logger.warn(`Failed to clean up session ${sessionId}: ${error.message}`);
                }
                this.sessions.delete(sessionId);
            }
        }
        
        if (cleaned > 0) {
            logger.info(`Cleaned up ${cleaned} idle sessions`);
        }
        
        setTimeout(() => this.cleanupIdleSessions(colab), 60 * 60 * 1000);
    }

    cleanupHangingProcesses() {
        const now = Date.now();
        let killed = 0;
        
        for (const [execId, execution] of this.activeExecutions.entries()) {
            if (now - execution.startedAt > CONFIG.EXECUTION_TIMEOUT * 1000 * 1.2) {
                try {
                    if (execution.process) {
                        execution.process.kill('SIGTERM');
                        killed++;
                        logger.warn(`Killed hanging process: ${execId}`);
                    }
                } catch (error) {
                    logger.warn(`Failed to kill hanging process ${execId}: ${error.message}`);
                }
                this.activeExecutions.delete(execId);
            }
        }
        
        if (killed > 0) {
            logger.info(`Killed ${killed} hanging processes`);
        }
    }
}

// ============================================
// EXECUTION ENGINE
// ============================================

async function executeCodeInColab(sessionId, cellNo, code, executionId, colab, sessionManager) {
    const session = sessionManager.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    if (Buffer.byteLength(code, 'utf8') > CONFIG.MAX_CODE_SIZE) {
        throw new Error(`Code exceeds ${CONFIG.MAX_CODE_SIZE} bytes`);
    }

    if (code.length > CONFIG.MAX_CODE_LENGTH) {
        throw new Error(`Code exceeds ${CONFIG.MAX_CODE_LENGTH} characters`);
    }

    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    
    const cellData = {
        type: 'execution',
        cellNo: cellNo,
        startedAt: new Date(startedAt).toISOString(),
        code: code.substring(0, 500),
        status: 'running'
    };

    try {
        const sessionFolder = path.join(CONFIG.SESSIONS_BASE_DIR, sessionId);
        const codeFile = path.join(sessionFolder, `code_${cellNo}.py`);
        await fs.writeFile(codeFile, code, 'utf8');

        const process = await colab.runWithStreaming([
            'exec', 
            '-s', session.colabSession, 
            '-f', codeFile, 
            '--timeout', String(CONFIG.EXECUTION_TIMEOUT)
        ], CONFIG.EXECUTION_TIMEOUT);

        sessionManager.activeExecutions.set(executionId, {
            sessionId,
            process,
            stdout: '',
            stderr: '',
            startedAt,
            cellNo
        });

        process.stdout.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;
            const exec = sessionManager.activeExecutions.get(executionId);
            if (exec) {
                exec.stdout = stdout;
                const sess = sessionManager.sessions.get(sessionId);
                if (sess && sess.currentExecution?.executionId === executionId) {
                    sess.currentExecution.partialOutput = stdout.substring(0, 10000);
                    sessionManager.sessions.set(sessionId, sess);
                }
            }
        });

        process.stderr.on('data', (data) => {
            const chunk = data.toString();
            stderr += chunk;
            const exec = sessionManager.activeExecutions.get(executionId);
            if (exec) exec.stderr = stderr;
        });

        const result = await new Promise((resolve, reject) => {
            process.on('close', (code) => {
                exitCode = detectExitCode(stdout + stderr);
                if (code !== 0 && exitCode === 0) {
                    resolve({ stdout, stderr, exitCode: 0 });
                } else if (code !== 0) {
                    reject({ error: new Error(`Process exited with code ${code}`), stdout, stderr, exitCode: code });
                } else {
                    resolve({ stdout, stderr, exitCode: 0 });
                }
            });
            
            process.on('error', (err) => {
                reject({ error: err, stdout, stderr });
            });

            setTimeout(() => {
                if (!process.killed) {
                    process.kill('SIGTERM');
                    reject({ error: new Error('Execution timeout'), stdout, stderr, exitCode: -2 });
                }
            }, CONFIG.EXECUTION_TIMEOUT * 1000 + 5000);
        });

        const completedAt = Date.now();
        const executionTime = completedAt - startedAt;
        const status = result.exitCode === 0 ? 'completed' : 'failed';
        
        const output = { 
            status,
            output: result.stdout || '(No output)', 
            error: result.stderr || '',
            startedAt, 
            completedAt,
            executionTime,
            exitCode: result.exitCode,
            executionId
        };
        
        sessionManager.completedExecutions.set(executionId, output);
        sessionManager.activeExecutions.delete(executionId);

        const updatedSession = sessionManager.sessions.get(sessionId);
        if (updatedSession && updatedSession.currentExecution?.executionId === executionId) {
            updatedSession.currentExecution = null;
            updatedSession.status = 'ready';
            updatedSession.cellCount = (updatedSession.cellCount || 0) + 1;
            updatedSession.executionCount = (updatedSession.executionCount || 0) + 1;
            sessionManager.sessions.set(sessionId, updatedSession);
        }

        cellData.status = status;
        cellData.completedAt = new Date(completedAt).toISOString();
        cellData.executionTime = executionTime;
        cellData.output = (result.stdout || '(No output)').substring(0, 10000);
        cellData.error = (result.stderr || '').substring(0, 1000);
        cellData.exitCode = result.exitCode;
        await sessionManager.appendSessionData(sessionId, cellData);

        logger.info(`Execution completed: ${executionId}`, { sessionId, cellNo, status, executionTime });
        return output;

    } catch (error) {
        const completedAt = Date.now();
        const executionTime = completedAt - startedAt;
        
        const failureResult = {
            status: 'failed',
            output: error.stdout || '',
            error: error.stderr || error.message || String(error),
            startedAt,
            completedAt,
            executionTime,
            exitCode: error.exitCode || -1,
            executionId
        };
        
        sessionManager.completedExecutions.set(executionId, failureResult);
        sessionManager.activeExecutions.delete(executionId);

        const updatedSession = sessionManager.sessions.get(sessionId);
        if (updatedSession && updatedSession.currentExecution?.executionId === executionId) {
            updatedSession.currentExecution = null;
            updatedSession.status = 'ready';
            sessionManager.sessions.set(sessionId, updatedSession);
        }

        cellData.status = 'failed';
        cellData.completedAt = new Date(completedAt).toISOString();
        cellData.executionTime = executionTime;
        cellData.output = (error.stdout || '').substring(0, 10000);
        cellData.error = (error.stderr || error.message || String(error)).substring(0, 1000);
        await sessionManager.appendSessionData(sessionId, cellData);

        logger.error(`Execution failed: ${executionId}`, { sessionId, cellNo, error: error.message });
        throw error;
    }
}

async function backgroundExecution(sessionId, cellNo, code, executionId, colab, sessionManager) {
    const execKey = `${sessionId}_${cellNo}`;
    if (sessionManager.executionQueue.has(execKey)) return;
    
    sessionManager.executionQueue.add(execKey);
    try {
        await executeCodeInColab(sessionId, cellNo, code, executionId, colab, sessionManager);
    } catch (error) {
        logger.error(`Background execution error:`, { sessionId, cellNo, error: error.message });
    } finally {
        sessionManager.executionQueue.delete(execKey);
    }
}

// ============================================
// MIDDLEWARE
// ============================================

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '10mb' }));

// ❌ NO STATIC FILE SERVING - API ONLY

// Simple request logging
app.use((req, res, next) => {
    logger.debug(`${req.method} ${req.path}`);
    next();
});

// Auth middleware
function authMiddleware(req, res, next) {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }
    next();
}

// Error handling middleware
app.use((err, req, res, next) => {
    const status = err.status || 500;
    logger.error(`Request error: ${err.message}`, { path: req.path, status });
    res.status(status).json({
        error: err.message || 'Internal server error',
        timestamp: new Date().toISOString()
    });
});

// ============================================
// API ENDPOINTS (100% Compatible)
// ============================================

// --- HEALTH ---

app.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();
    res.json({
        status: 'healthy',
        version: '2.0.0',
        activeSessions: sessionManager.sessions.size,
        maxSessions: CONFIG.MAX_SESSIONS,
        sessionDetails: Array.from(sessionManager.sessions.entries()).map(([id, s]) => ({
            id: id.slice(0, 12) + '...',
            colabSession: s.colabSession,
            createdAt: new Date(s.createdAt).toISOString(),
            lastActivity: new Date(s.lastActivity).toISOString(),
            status: s.status,
            hasCurrentExecution: !!s.currentExecution,
            cellCount: s.cellCount || 0
        })),
        completedExecutions: sessionManager.completedExecutions.size,
        activeExecutions: sessionManager.activeExecutions.size,
        queuedExecutions: sessionManager.executionQueue.size,
        uptime: process.uptime(),
        memoryUsage: {
            rss: formatMemory(memUsage.rss),
            heapTotal: formatMemory(memUsage.heapTotal),
            heapUsed: formatMemory(memUsage.heapUsed),
            external: formatMemory(memUsage.external),
            arrayBuffers: formatMemory(memUsage.arrayBuffers)
        },
        timestamp: new Date().toISOString(),
        colabBinary: colab.binary,
        usePythonModule: colab.usePythonModule,
        hasAuthToken: !!CONFIG.COLAB_AUTH_TOKEN,
        nodeEnv: CONFIG.NODE_ENV
    });
});

app.get('/health/simple', (req, res) => {
    res.json({
        status: 'up',
        timestamp: new Date().toISOString(),
        sessions: sessionManager.sessions.size
    });
});

// --- DEBUG ENDPOINTS ---

app.get('/debug/sessions', authMiddleware, async (req, res) => {
    const memUsage = process.memoryUsage();
    const sessionData = [];
    let totalCells = 0;
    let totalExecutions = 0;

    for (const [id, session] of sessionManager.sessions.entries()) {
        const dataFile = await sessionManager.getSessionData(id);
        const cellsCount = dataFile?.cells?.length || 0;
        const executionsCount = dataFile?.totalExecutions || 0;
        totalCells += cellsCount;
        totalExecutions += executionsCount;

        sessionData.push({
            sessionId: id,
            colabSession: session.colabSession,
            status: session.status,
            createdAt: new Date(session.createdAt).toISOString(),
            lastActivity: new Date(session.lastActivity).toISOString(),
            activeMinutes: ((Date.now() - session.createdAt) / 1000 / 60).toFixed(2),
            cellsExecuted: cellsCount,
            executions: executionsCount,
            hasCurrentExecution: !!session.currentExecution,
            folder: session.folder,
            dataFileExists: dataFile !== null
        });
    }

    res.json({
        totalSessions: sessionManager.sessions.size,
        maxSessions: CONFIG.MAX_SESSIONS,
        sessions: sessionData,
        memoryUsage: {
            rss: formatMemory(memUsage.rss),
            heapTotal: formatMemory(memUsage.heapTotal),
            heapUsed: formatMemory(memUsage.heapUsed)
        },
        totalCellsExecuted: totalCells,
        totalExecutions: totalExecutions,
        queuedExecutions: sessionManager.executionQueue.size,
        completedExecutions: sessionManager.completedExecutions.size,
        activeExecutions: sessionManager.activeExecutions.size,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.get('/debug/sessions/:sessionId', authMiddleware, async (req, res) => {
    const { sessionId } = req.params;
    const session = sessionManager.sessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found in memory' });
    }

    const sessionData = await sessionManager.getSessionData(sessionId);
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
            heapUsed: formatMemory(memUsage.heapUsed)
        },
        timestamp: new Date().toISOString()
    });
});

// --- SESSION MANAGEMENT ---

app.post('/start', authMiddleware, async (req, res, next) => {
    try {
        if (sessionManager.sessions.size >= CONFIG.MAX_SESSIONS) {
            logger.info(`Max sessions reached (${sessionManager.sessions.size}/${CONFIG.MAX_SESSIONS})`);
            let oldestSessionId = null;
            let oldestTime = Infinity;
            
            for (const [sessionId, session] of sessionManager.sessions.entries()) {
                if (session.lastActivity < oldestTime && session.status !== 'busy') {
                    oldestTime = session.lastActivity;
                    oldestSessionId = sessionId;
                }
            }
            
            if (oldestSessionId) {
                const session = sessionManager.sessions.get(oldestSessionId);
                logger.info(`Killing oldest session: ${oldestSessionId}`);
                try {
                    await colab.run(['stop', '-s', session.colabSession], 10000);
                } catch (error) {
                    logger.warn(`Could not stop session remotely: ${error.message}`);
                }
                await sessionManager.cleanupSessionFolder(oldestSessionId);
                sessionManager.sessions.delete(oldestSessionId);
                logger.info(`Removed session ${oldestSessionId}`);
            }
        }

        const sessionId = generateSessionId();
        const colabSessionName = `colab_${sessionId.substring(0, 12)}`;

        logger.info(`Creating new session: ${sessionId}`);

        await sessionManager.createSessionFolder(sessionId);
        
        const initialData = {
            sessionId: sessionId,
            createdAt: new Date().toISOString(),
            cells: [],
            totalCells: 0,
            totalExecutions: 0,
            lastUpdated: new Date().toISOString(),
            metadata: { version: '2.0.0' }
        };
        const dataFile = path.join(
            path.join(CONFIG.SESSIONS_BASE_DIR, sessionId), 
            'session_data.json'
        );
        await fs.writeFile(dataFile, JSON.stringify(initialData, null, 2));
        
        await colab.run(['new', '--gpu', 'T4', '-s', colabSessionName], 60000);
        
        sessionManager.sessions.set(sessionId, {
            colabSession: colabSessionName,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            status: 'ready',
            currentExecution: null,
            folder: path.join(CONFIG.SESSIONS_BASE_DIR, sessionId),
            cellCount: 0,
            executionCount: 0
        });

        logger.info(`Session created successfully: ${sessionId}`);

        res.json({
            success: true,
            sessionId: sessionId,
            authUrl: null,
            expiresIn: CONFIG.SESSION_TIMEOUT,
            activeSessions: sessionManager.sessions.size,
            maxSessions: CONFIG.MAX_SESSIONS,
            message: 'Session created successfully'
        });
    } catch (error) {
        logger.error(`Session creation failed: ${error.message}`);
        next(new Error('Failed to create session'));
    }
});

app.post('/keepalive', authMiddleware, async (req, res, next) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    const session = sessionManager.sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        await colab.run(['sessions'], 10000);
        session.lastActivity = Date.now();
        sessionManager.sessions.set(sessionId, session);
        res.json({ success: true, message: 'Session kept alive' });
    } catch (error) {
        res.status(500).json({ error: 'Keepalive failed', details: error.message });
    }
});

// --- CODE EXECUTION ---

app.post('/run', authMiddleware, async (req, res, next) => {
    const { sessionId, code, cellNo } = req.body;
    
    if (!sessionId || !code || cellNo === undefined) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, code, cellNo' });
    }

    const session = sessionManager.sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status === 'busy') {
        return res.status(409).json({ 
            error: 'Session busy',
            currentExecution: session.currentExecution
        });
    }

    const executionId = generateExecutionId();
    const validCellNo = parseInt(cellNo, 10);

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
    sessionManager.sessions.set(sessionId, session);

    const cellStartData = {
        type: 'execution_start',
        cellNo: validCellNo,
        startedAt: new Date().toISOString(),
        code: code.substring(0, 200),
        status: 'started'
    };
    await sessionManager.appendSessionData(sessionId, cellStartData);

    backgroundExecution(sessionId, validCellNo, code, executionId, colab, sessionManager);

    logger.info(`Execution started: ${executionId}`, { sessionId, cellNo: validCellNo });

    res.json({
        status: 'processing',
        sessionId: sessionId,
        executionId: executionId,
        pollInterval: CONFIG.POLL_INTERVAL,
        message: 'Code execution started. Poll /status for results.'
    });
});

app.post('/status', authMiddleware, async (req, res) => {
    const { sessionId, executionId } = req.body;
    if (!sessionId || !executionId) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, executionId' });
    }

    if (sessionManager.completedExecutions.has(executionId)) {
        const record = sessionManager.completedExecutions.get(executionId);
        return res.json({
            status: record.status,
            output: record.output,
            error: record.error,
            executionTime: record.executionTime,
            exitCode: record.exitCode
        });
    }

    const active = sessionManager.activeExecutions.get(executionId);
    if (active) {
        const elapsed = Date.now() - active.startedAt;
        return res.json({
            status: 'running',
            elapsed: elapsed,
            partialOutput: (active.stdout || '').substring(0, 10000),
            partialError: (active.stderr || '').substring(0, 1000)
        });
    }

    const session = sessionManager.sessions.get(sessionId);
    if (session && session.currentExecution?.executionId === executionId) {
        return res.json({
            status: 'running',
            elapsed: Date.now() - session.currentExecution.startedAt,
            partialOutput: session.currentExecution.partialOutput || '',
            partialError: session.currentExecution.partialError || ''
        });
    }

    res.json({ 
        status: 'not_found',
        message: 'Execution not found or already completed'
    });
});

app.post('/status/ack', authMiddleware, async (req, res) => {
    const { executionId } = req.body;
    if (executionId && sessionManager.completedExecutions.has(executionId)) {
        sessionManager.completedExecutions.delete(executionId);
        res.json({ success: true, message: 'Acknowledged' });
    } else {
        res.json({ success: false, message: 'Execution not found' });
    }
});

app.delete('/session/:sessionId', authMiddleware, async (req, res, next) => {
    const { sessionId } = req.params;
    const session = sessionManager.sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        await colab.run(['stop', '-s', session.colabSession], 30000);
        await sessionManager.cleanupSessionFolder(sessionId);
        sessionManager.sessions.delete(sessionId);
        logger.info(`Session deleted: ${sessionId}`);
        res.json({ success: true, message: 'Session terminated' });
    } catch (error) {
        logger.warn(`Session deletion error: ${error.message}`);
        await sessionManager.cleanupSessionFolder(sessionId);
        sessionManager.sessions.delete(sessionId);
        res.json({ 
            success: true, 
            warning: 'Session removed from tracking, but may still exist remotely' 
        });
    }
});

// ============================================
// 404 HANDLER - MUST BE LAST
// ============================================

app.use((req, res) => {
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
// GRACEFUL SHUTDOWN
// ============================================

let shutdownInProgress = false;

async function gracefulShutdown(signal) {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    
    logger.info(`Received ${signal}, starting graceful shutdown...`);
    
    for (const sessionId of sessionManager.sessions.keys()) {
        try {
            const session = sessionManager.sessions.get(sessionId);
            if (session) {
                await colab.run(['stop', '-s', session.colabSession], 10000);
                await sessionManager.cleanupSessionFolder(sessionId);
                sessionManager.sessions.delete(sessionId);
            }
        } catch (error) {
            logger.warn(`Failed to clean up session ${sessionId}: ${error.message}`);
        }
    }
    
    logger.info('Shutdown complete');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', { error: error.message });
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', { reason });
});

// ============================================
// INITIALIZATION
// ============================================

const colab = new ColabBinaryManager();
const sessionManager = new SessionManager(CONFIG.SESSIONS_BASE_DIR);

async function init() {
    try {
        logger.info('🚀 Initializing Colab Orchestrator v2.0 (API-Only)...');
        
        CONFIG.validate();
        logger.info('✅ Configuration validated');
        
        await colab.initialize();
        
        await fs.mkdir(CONFIG.SESSIONS_BASE_DIR, { recursive: true });
        logger.info(`📁 Sessions directory: ${CONFIG.SESSIONS_BASE_DIR}`);
        
        await setupColabAuth();
        await colab.testConnection();
        
        sessionManager.startCleanupInterval();
        setTimeout(() => sessionManager.cleanupIdleSessions(colab), 60 * 60 * 1000);
        setInterval(() => sessionManager.cleanupHangingProcesses(), 5 * 60 * 1000);
        
        const PORT = CONFIG.PORT;
        app.listen(PORT, () => {
            console.log(`
╔══════════════════════════════════════════════════════════╗
║  🚀 Colab Orchestrator v2.0 (API-Only)                 ║
╠══════════════════════════════════════════════════════════╣
║  📡 Port: ${PORT}                                              ║
║  📁 Sessions: ${CONFIG.SESSIONS_BASE_DIR}       ║
║  🔧 Binary: ${colab.binary} ${colab.usePythonModule ? '(-m colab_cli)' : ''}
║  📊 Max Sessions: ${CONFIG.MAX_SESSIONS}                                      ║
║  🔐 Auth: ${CONFIG.COLAB_AUTH_TOKEN ? '✅ Configured' : '❌ Not configured'}                             ║
║  ⏰ Session Timeout: ${CONFIG.SESSION_TIMEOUT / 1000 / 60 / 60}h                            ║
║  ⏱️  Execution Timeout: ${CONFIG.EXECUTION_TIMEOUT / 60}m                              ║
║  🔒 CORS: ${allowedOrigins.length} allowed origins                         ║
║  🌐 Environment: ${CONFIG.NODE_ENV}                                        ║
║  📦 API-Only: No static files served                       ║
╚══════════════════════════════════════════════════════════╝
            `);
            
            logger.info(`🌐 API server running on http://localhost:${PORT}`);
            logger.info(`🔑 API Secret: ${CONFIG.API_SECRET === 'kushalkumarjthegreat' ? '⚠️ Default' : '✅ Custom'}`);
            logger.info(`📊 Health check: http://localhost:${PORT}/health`);
            logger.info(`📋 API docs: http://localhost:${PORT}/ (shows endpoints)`);
        });
        
    } catch (error) {
        logger.error('Fatal initialization error:', { error: error.message });
        process.exit(1);
    }
}

init();
