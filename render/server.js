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
// CONFIGURATION
// ============================================

const CONFIG = {
    API_SECRET: process.env.API_SECRET,
    MAX_SESSIONS: parseInt(process.env.MAX_SESSIONS) || 3,
    SESSION_TIMEOUT: parseInt(process.env.SESSION_TIMEOUT) || 3 * 60 * 60 * 1000,
    EXECUTION_TIMEOUT: parseInt(process.env.EXECUTION_TIMEOUT) || 7200,
    MAX_CODE_SIZE: parseInt(process.env.MAX_CODE_SIZE) || 3 * 1024 * 1024,
    COMPLETED_EXECUTIONS_TTL: parseInt(process.env.COMPLETED_EXECUTIONS_TTL) || 10 * 60 * 1000,
    POLL_INTERVAL: parseInt(process.env.POLL_INTERVAL) || 15000,
    SESSIONS_BASE_DIR: process.env.SESSIONS_BASE_DIR || path.join(os.tmpdir(), 'colab_sessions'),
    COLAB_AUTH_TOKEN: process.env.COLAB_AUTH_TOKEN,
    PORT: process.env.PORT || 3000,
    NODE_ENV: process.env.NODE_ENV || 'development',
    LOG_LEVEL: process.env.LOG_LEVEL || 'debug'
};

// ============================================
// ULTRA DETAILED LOGGER
// ============================================

class Logger {
    constructor(level = 'info') {
        this.levels = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
        this.level = this.levels[level] ?? 2;
        this.colors = {
            error: '\x1b[31m',
            warn: '\x1b[33m',
            info: '\x1b[36m',
            debug: '\x1b[35m',
            trace: '\x1b[90m',
            reset: '\x1b[0m',
            bright: '\x1b[1m',
            session: '\x1b[32m',
            exec: '\x1b[33m',
            code: '\x1b[36m',
            output: '\x1b[37m'
        };
    }

    _format(level, message, meta = {}) {
        const timestamp = new Date().toISOString();
        const color = this.colors[level] || '';
        const reset = this.colors.reset;
        const bright = this.colors.bright;
        
        let metaStr = '';
        if (Object.keys(meta).length > 0) {
            const parts = [];
            if (meta.sessionId) {
                parts.push(`${bright}📋 SESSION:${reset}${this.colors.session} ${meta.sessionId.substring(0, 16)}...${reset}`);
                delete meta.sessionId;
            }
            if (meta.executionId) {
                parts.push(`${bright}⚡ EXEC:${reset}${this.colors.exec} ${meta.executionId}${reset}`);
                delete meta.executionId;
            }
            if (meta.cellNo !== undefined) {
                parts.push(`${bright}📄 CELL:${reset} ${meta.cellNo}`);
                delete meta.cellNo;
            }
            if (meta.code) {
                const codeSnippet = meta.code.length > 200 ? meta.code.substring(0, 200) + '...' : meta.code;
                parts.push(`${bright}💻 CODE:${reset}${this.colors.code}\n${codeSnippet}${reset}`);
                delete meta.code;
            }
            if (meta.status) {
                parts.push(`${bright}📊 STATUS:${reset} ${meta.status}`);
                delete meta.status;
            }
            if (meta.duration) {
                parts.push(`${bright}⏱️  DURATION:${reset} ${meta.duration}ms`);
                delete meta.duration;
            }
            if (meta.fullOutput !== undefined) {
                const outputLines = meta.fullOutput.split('\n').length;
                const outputPreview = meta.fullOutput.length > 500 ? meta.fullOutput.substring(0, 500) + '...' : meta.fullOutput;
                parts.push(`${bright}📤 FULL OUTPUT (${outputLines} lines, ${meta.fullOutput.length} chars):${reset}${this.colors.output}\n${outputPreview}${reset}`);
                delete meta.fullOutput;
            }
            if (meta.output) {
                const outputLines = meta.output.split('\n').length;
                const outputPreview = meta.output.length > 500 ? meta.output.substring(0, 500) + '...' : meta.output;
                parts.push(`${bright}📤 OUTPUT (${outputLines} lines, ${meta.output.length} chars):${reset}${this.colors.output}\n${outputPreview}${reset}`);
                delete meta.output;
            }
            if (meta.error) {
                const errorPreview = meta.error.length > 500 ? meta.error.substring(0, 500) + '...' : meta.error;
                parts.push(`${bright}❌ ERROR:${reset}\n${errorPreview}`);
                delete meta.error;
            }
            if (meta.exitCode !== undefined) {
                parts.push(`${bright}🚪 EXIT CODE:${reset} ${meta.exitCode}`);
                delete meta.exitCode;
            }
            if (meta.stdoutSize !== undefined) {
                parts.push(`${bright}📤 STDOUT SIZE:${reset} ${meta.stdoutSize} bytes`);
                delete meta.stdoutSize;
            }
            if (meta.stderrSize !== undefined) {
                parts.push(`${bright}📤 STDERR SIZE:${reset} ${meta.stderrSize} bytes`);
                delete meta.stderrSize;
            }
            // Remaining meta
            for (const [key, value] of Object.entries(meta)) {
                if (value !== undefined && value !== null && typeof value !== 'object') {
                    parts.push(`${bright}${key}:${reset} ${value}`);
                }
            }
            metaStr = parts.length > 0 ? `\n  ${parts.join('\n  ')}` : '';
        }
        
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
    trace(message, meta) {
        if (this.level >= this.levels.trace) console.log(this._format('trace', message, meta));
    }
    
    // Special methods for common operations
    sessionCreated(sessionId, colabSession, activeSessions) {
        this.info(`🆕 SESSION CREATED`, { 
            sessionId, 
            colabSession, 
            activeSessions,
            timestamp: new Date().toISOString()
        });
    }
    
    sessionDeleted(sessionId, reason = 'manual') {
        this.info(`🗑️ SESSION DELETED`, { sessionId, reason });
    }
    
    sessionBusy(sessionId, executionId) {
        this.warn(`⏳ SESSION BUSY`, { sessionId, executionId });
    }
    
    executionStarted(sessionId, executionId, cellNo, code) {
        this.info(`▶️ EXECUTION STARTED`, {
            sessionId,
            executionId,
            cellNo,
            code: code.substring(0, 500),
            codeLength: code.length,
            timestamp: new Date().toISOString()
        });
    }
    
    executionCompleted(sessionId, executionId, cellNo, duration, status, fullOutput, error, exitCode) {
        this.info(`✅ EXECUTION COMPLETED`, {
            sessionId,
            executionId,
            cellNo,
            duration,
            status,
            fullOutput: fullOutput || '(No output)',
            exitCode: exitCode !== undefined ? exitCode : 0,
            error: error || undefined,
            timestamp: new Date().toISOString()
        });
    }
    
    executionFailed(sessionId, executionId, cellNo, duration, error, fullOutput) {
        this.error(`❌ EXECUTION FAILED`, {
            sessionId,
            executionId,
            cellNo,
            duration,
            fullOutput: fullOutput || '(No output)',
            error: error.substring(0, 500),
            timestamp: new Date().toISOString()
        });
    }
    
    colabCommand(command, args) {
        this.debug(`🔧 COLAB COMMAND`, {
            command: `${command} ${args.join(' ')}`,
            args
        });
    }
    
    binaryFound(path) {
        this.info(`🔍 COLAB BINARY FOUND`, { path });
    }
    
    authStatus(status, details) {
        this.info(`🔐 AUTH STATUS: ${status}`, details);
    }
}

const logger = new Logger(CONFIG.LOG_LEVEL);

// ============================================
// CORS
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
        logger.warn(`🚫 CORS BLOCKED`, { origin });
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
    if (systemExitMatch) return parseInt(systemExitMatch[1]);
    if (output.includes('Traceback') || output.includes('Error:')) return 1;
    return 0;
}

function getCodeSnippet(code, maxLength = 200) {
    if (code.length <= maxLength) return code;
    return code.substring(0, maxLength) + '...';
}

// ============================================
// COLAB BINARY MANAGER
// ============================================

class ColabBinaryManager {
    constructor() {
        this.binary = 'colab';
        this.usePythonModule = false;
        this.isInitialized = false;
    }

    async findBinary() {
        logger.info('🔍 SEARCHING FOR COLAB BINARY...');
        
        try {
            const { stdout } = await execPromise('which colab 2>/dev/null || echo ""', { timeout: 5000 });
            if (stdout.trim()) {
                logger.binaryFound(stdout.trim());
                return stdout.trim();
            }
        } catch (e) {
            logger.debug('which colab failed', { error: e.message });
        }

        try {
            const { stdout } = await execPromise(
                'pip3 show google-colab-cli 2>/dev/null | grep Location | cut -d" " -f2',
                { timeout: 5000 }
            );
            if (stdout.trim()) {
                const binaryPath = path.join(stdout.trim(), 'colab_cli/__main__.py');
                try {
                    await fs.access(binaryPath);
                    logger.binaryFound(`python3 -m colab_cli (pip: ${stdout.trim()})`);
                    return 'python3';
                } catch (e) {}
            }
        } catch (e) {
            logger.debug('pip show failed', { error: e.message });
        }

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
                const { stdout } = await execPromise(
                    `find ${searchPath} -name "colab" -type f 2>/dev/null | head -1`,
                    { timeout: 10000 }
                );
                if (stdout.trim()) {
                    logger.binaryFound(stdout.trim());
                    try {
                        await execPromise(`chmod +x "${stdout.trim()}"`, { stdio: 'ignore' });
                    } catch (e) {}
                    return stdout.trim();
                }
            } catch (e) {
                logger.debug(`Search in ${searchPath} failed`, { error: e.message });
            }
        }

        try {
            await execPromise('python3 -c "import colab_cli" 2>/dev/null', { timeout: 5000 });
            logger.binaryFound('python3 -m colab_cli (module)');
            return 'python3';
        } catch (e) {
            logger.debug('Python module check failed', { error: e.message });
        }

        logger.warn('⚠️ COLAB BINARY NOT FOUND - using python3 module fallback');
        return 'python3';
    }

    async initialize() {
        if (this.isInitialized) return;
        
        const binary = await this.findBinary();
        if (binary === 'python3') {
            this.usePythonModule = true;
            this.binary = 'python3';
            logger.info(`🔧 USING PYTHON MODULE: ${this.binary} -m colab_cli`);
        } else {
            this.binary = binary;
            this.usePythonModule = false;
            logger.info(`🔧 USING COLAB BINARY: ${this.binary}`);
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
            
            logger.colabCommand(this.binary, args);
            
            exec(command, { 
                timeout, 
                shell: '/bin/bash', 
                maxBuffer: 50 * 1024 * 1024,
                env: { ...process.env, PYTHONUNBUFFERED: '1' }
            }, (error, stdout, stderr) => {
                if (error && error.code !== 0) {
                    logger.error(`COLAB COMMAND FAILED`, { 
                        command: command.substring(0, 200),
                        code: error.code,
                        stderr: stderr ? stderr.substring(0, 500) : 'none'
                    });
                    reject({ error, stdout, stderr, code: error.code });
                } else {
                    logger.debug(`COLAB COMMAND SUCCESS`, { 
                        stdout: stdout ? stdout.substring(0, 200) : 'empty',
                        stderr: stderr ? stderr.substring(0, 200) : 'empty'
                    });
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

        logger.colabCommand(command, cmdArgs);
        logger.info(`📤 STREAMING EXECUTION STARTED`, { 
            command: command,
            args: cmdArgs.join(' ').substring(0, 200)
        });

        return spawn(command, cmdArgs, {
            shell: true,
            timeout: timeout * 1000,
            env: { ...process.env, PYTHONUNBUFFERED: '1' }
        });
    }

    async testConnection() {
        try {
            const { stdout } = await this.run(['--version'], 10000);
            logger.info(`✅ COLAB CLI CONNECTION TEST PASSED`, { version: stdout.trim() });
            return true;
        } catch (error) {
            logger.error(`❌ COLAB CLI CONNECTION TEST FAILED`, { error: error.message });
            return false;
        }
    }
}

// ============================================
// AUTH SETUP - FIXED FOR "token" FIELD
// ============================================

async function setupColabAuth() {
    if (!CONFIG.COLAB_AUTH_TOKEN) {
        logger.warn('⚠️ COLAB_AUTH_TOKEN NOT FOUND');
        return false;
    }

    try {
        let rawToken = CONFIG.COLAB_AUTH_TOKEN.trim();
        if ((rawToken.startsWith("'") && rawToken.endsWith("'")) || 
            (rawToken.startsWith('"') && rawToken.endsWith('"'))) {
            rawToken = rawToken.slice(1, -1);
            logger.debug('📝 Stripped quotes from token');
        }

        const tokenData = JSON.parse(rawToken);
        
        const accessToken = tokenData.token || tokenData.access_token;
        if (!accessToken) {
            logger.error('❌ AUTH FAILED: missing "token" or "access_token" field');
            return false;
        }

        logger.authStatus('✅ Token parsed successfully', {
            hasRefreshToken: !!tokenData.refresh_token,
            hasClientId: !!tokenData.client_id,
            expiry: tokenData.expiry || 'unknown'
        });
        
        const cliTokenData = {
            access_token: accessToken,
            refresh_token: tokenData.refresh_token || '',
            token_uri: tokenData.token_uri || 'https://oauth2.googleapis.com/token',
            client_id: tokenData.client_id || '',
            client_secret: tokenData.client_secret || '',
            scopes: tokenData.scopes || [],
            universe_domain: tokenData.universe_domain || 'googleapis.com',
            account: tokenData.account || '',
            expiry: tokenData.expiry || ''
        };

        const configDir = path.join(os.homedir(), '.config/colab-cli');
        await fs.mkdir(configDir, { recursive: true });
        logger.debug(`📁 Config directory: ${configDir}`);
        
        const tokenPath = path.join(configDir, 'token.json');
        await fs.writeFile(tokenPath, JSON.stringify(cliTokenData, null, 2));
        logger.authStatus('✅ Token file written', { path: tokenPath });

        const sessionsPath = path.join(configDir, 'sessions.json');
        await fs.writeFile(sessionsPath, JSON.stringify({}));
        logger.debug(`📁 Sessions file written: ${sessionsPath}`);
        
        return true;
    } catch (error) {
        logger.error('❌ AUTH SETUP FAILED', { error: error.message });
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
        logger.debug(`📁 Session folder created: ${sessionFolder}`);
        return sessionFolder;
    }

    async cleanupSessionFolder(sessionId) {
        const sessionFolder = path.join(this.baseDir, sessionId);
        try {
            await fs.rm(sessionFolder, { recursive: true, force: true });
            logger.debug(`🗑️ Session folder cleaned: ${sessionFolder}`);
            this.sessionDataCache.delete(sessionId);
        } catch (error) {
            logger.error(`❌ Failed to cleanup folder for ${sessionId}`, { error: error.message });
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
            logger.trace(`📝 Session data appended`, { sessionId, dataFile, totalCells: sessionData.totalCells });
            return sessionData;
        } catch (error) {
            logger.error(`❌ Failed to append session data`, { sessionId, error: error.message });
            return null;
        }
    }

    async getSessionData(sessionId) {
        const cached = this.sessionDataCache.get(sessionId);
        if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
            logger.trace(`📦 Session data from cache`, { sessionId });
            return cached.data;
        }

        const sessionFolder = path.join(this.baseDir, sessionId);
        const dataFile = path.join(sessionFolder, 'session_data.json');
        
        try {
            const content = await fs.readFile(dataFile, 'utf8');
            const data = JSON.parse(content);
            this.sessionDataCache.set(sessionId, { data, timestamp: Date.now() });
            logger.trace(`📂 Session data from disk`, { sessionId });
            return data;
        } catch {
            logger.trace(`📭 No session data found`, { sessionId });
            return null;
        }
    }

    startCleanupInterval() {
        setInterval(() => {
            const now = Date.now();
            let cleaned = 0;
            for (const [execId, data] of this.completedExecutions.entries()) {
                if (now - data.completedAt > CONFIG.COMPLETED_EXECUTIONS_TTL) {
                    this.completedExecutions.delete(execId);
                    cleaned++;
                }
            }
            if (cleaned > 0) {
                logger.debug(`🧹 Cleaned ${cleaned} completed executions from memory`);
            }
        }, 60000);
    }

    async cleanupIdleSessions(colab) {
        const now = Date.now();
        let cleaned = 0;
        
        for (const [sessionId, session] of this.sessions.entries()) {
            const idleTime = now - session.lastActivity;
            if (idleTime > CONFIG.SESSION_TIMEOUT && session.status !== 'busy') {
                logger.info(`🧹 CLEANING IDLE SESSION`, {
                    sessionId: sessionId.substring(0, 16),
                    idleTime: Math.floor(idleTime / 60000) + 'm',
                    colabSession: session.colabSession
                });
                try {
                    await colab.run(['stop', '-s', session.colabSession], 10000);
                    await this.cleanupSessionFolder(sessionId);
                    cleaned++;
                } catch (error) {
                    logger.warn(`⚠️ Failed to clean up session`, { sessionId: sessionId.substring(0, 16), error: error.message });
                }
                this.sessions.delete(sessionId);
            }
        }
        
        if (cleaned > 0) {
            logger.info(`🧹 Cleaned ${cleaned} idle sessions`);
        }
        
        setTimeout(() => this.cleanupIdleSessions(colab), 60 * 60 * 1000);
    }

    cleanupHangingProcesses() {
        const now = Date.now();
        let killed = 0;
        
        for (const [execId, execution] of this.activeExecutions.entries()) {
            const elapsed = now - execution.startedAt;
            if (elapsed > CONFIG.EXECUTION_TIMEOUT * 1000 * 1.2) {
                logger.warn(`⚠️ KILLING HANGING PROCESS`, {
                    executionId: execId,
                    sessionId: execution.sessionId.substring(0, 16),
                    elapsed: Math.floor(elapsed / 1000) + 's',
                    cellNo: execution.cellNo
                });
                try {
                    if (execution.process) {
                        execution.process.kill('SIGTERM');
                        killed++;
                    }
                } catch (error) {
                    logger.error(`❌ Failed to kill hanging process`, { executionId: execId, error: error.message });
                }
                this.activeExecutions.delete(execId);
            }
        }
        
        if (killed > 0) {
            logger.info(`🔫 Killed ${killed} hanging processes`);
        }
    }

    getStats() {
        return {
            totalSessions: this.sessions.size,
            activeExecutions: this.activeExecutions.size,
            completedExecutions: this.completedExecutions.size,
            queuedExecutions: this.executionQueue.size
        };
    }
}

// ============================================
// EXECUTION ENGINE
// ============================================

async function executeCodeInColab(sessionId, cellNo, code, executionId, colab, sessionManager) {
    const session = sessionManager.sessions.get(sessionId);
    if (!session) {
        logger.error(`❌ SESSION NOT FOUND`, { sessionId: sessionId.substring(0, 16) });
        throw new Error('Session not found');
    }

    logger.debug(`📝 CODE DETAILS`, {
        sessionId: sessionId.substring(0, 16),
        cellNo,
        codeLength: code.length,
        codeSize: Buffer.byteLength(code, 'utf8'),
        codePreview: getCodeSnippet(code, 150)
    });

    if (Buffer.byteLength(code, 'utf8') > CONFIG.MAX_CODE_SIZE) {
        logger.error(`❌ CODE TOO LARGE`, {
            sessionId: sessionId.substring(0, 16),
            size: Buffer.byteLength(code, 'utf8'),
            maxSize: CONFIG.MAX_CODE_SIZE
        });
        throw new Error(`Code exceeds ${CONFIG.MAX_CODE_SIZE} bytes`);
    }

    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    
    const cellData = {
        type: 'execution',
        cellNo: cellNo,
        startedAt: new Date(startedAt).toISOString(),
        code: getCodeSnippet(code, 500),
        status: 'running'
    };

    try {
        const sessionFolder = path.join(CONFIG.SESSIONS_BASE_DIR, sessionId);
        const codeFile = path.join(sessionFolder, `code_${cellNo}.py`);
        await fs.writeFile(codeFile, code, 'utf8');
        logger.debug(`📄 Code file written`, { sessionId: sessionId.substring(0, 16), codeFile });

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
            let resolved = false;
            
            process.on('close', (code) => {
                if (resolved) return;
                resolved = true;
                exitCode = detectExitCode(stdout + stderr);
                logger.debug(`🔚 PROCESS CLOSED`, {
                    executionId,
                    sessionId: sessionId.substring(0, 16),
                    code,
                    exitCode,
                    stdoutSize: stdout.length,
                    stderrSize: stderr.length
                });
                if (code !== 0 && exitCode === 0) {
                    resolve({ stdout, stderr, exitCode: 0 });
                } else if (code !== 0) {
                    reject({ error: new Error(`Process exited with code ${code}`), stdout, stderr, exitCode: code });
                } else {
                    resolve({ stdout, stderr, exitCode: 0 });
                }
            });
            
            process.on('error', (err) => {
                if (resolved) return;
                resolved = true;
                logger.error(`❌ PROCESS ERROR`, {
                    executionId,
                    sessionId: sessionId.substring(0, 16),
                    error: err.message
                });
                reject({ error: err, stdout, stderr });
            });

            setTimeout(() => {
                if (!resolved && !process.killed) {
                    process.kill('SIGTERM');
                    resolved = true;
                    logger.warn(`⏰ EXECUTION TIMEOUT - killing process`, {
                        executionId,
                        sessionId: sessionId.substring(0, 16),
                        timeout: CONFIG.EXECUTION_TIMEOUT
                    });
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

        // ============================================
        // ENHANCED: Log FULL output on completion
        // ============================================
        logger.executionCompleted(
            sessionId, 
            executionId, 
            cellNo, 
            executionTime, 
            status,
            result.stdout || '(No output)',  // FULL OUTPUT
            result.stderr || '',
            result.exitCode
        );

        return output;

    } catch (error) {
        const completedAt = Date.now();
        const executionTime = completedAt - startedAt;
        
        // ============================================
        // ENHANCED: Log FULL output on failure too
        // ============================================
        logger.executionFailed(
            sessionId,
            executionId,
            cellNo,
            executionTime,
            error.message || String(error),
            error.stdout || '(No output)'  // FULL OUTPUT
        );
        
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

        throw error;
    }
}

async function backgroundExecution(sessionId, cellNo, code, executionId, colab, sessionManager) {
    const execKey = `${sessionId}_${cellNo}`;
    if (sessionManager.executionQueue.has(execKey)) {
        logger.warn(`⏳ EXECUTION ALREADY QUEUED`, { sessionId: sessionId.substring(0, 16), cellNo });
        return;
    }
    
    logger.debug(`📋 Adding to execution queue`, { sessionId: sessionId.substring(0, 16), cellNo, executionId });
    sessionManager.executionQueue.add(execKey);
    try {
        await executeCodeInColab(sessionId, cellNo, code, executionId, colab, sessionManager);
    } catch (error) {
        logger.error(`💥 BACKGROUND EXECUTION ERROR`, {
            sessionId: sessionId.substring(0, 16),
            cellNo,
            executionId,
            error: error.message
        });
    } finally {
        sessionManager.executionQueue.delete(execKey);
        logger.debug(`📋 Removed from execution queue`, { sessionId: sessionId.substring(0, 16), cellNo });
    }
}

// ============================================
// MIDDLEWARE
// ============================================

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '10mb' }));

// NO STATIC FILE SERVING - API ONLY

app.use((req, res, next) => {
    const startTime = Date.now();
    const traceId = crypto.randomBytes(8).toString('hex');
    req.traceId = traceId;
    
    logger.debug(`📨 REQUEST RECEIVED`, {
        traceId,
        method: req.method,
        path: req.path,
        ip: req.ip || req.get('x-forwarded-for') || 'unknown',
        userAgent: req.get('user-agent') || 'unknown'
    });
    
    const originalSend = res.send;
    res.send = function(data) {
        const duration = Date.now() - startTime;
        logger.debug(`📤 RESPONSE SENT`, {
            traceId,
            status: res.statusCode,
            duration: duration + 'ms'
        });
        originalSend.call(this, data);
    };
    
    next();
});

function authMiddleware(req, res, next) {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        logger.warn(`🔒 AUTH FAILED`, {
            traceId: req.traceId,
            path: req.path,
            provided: apiSecret ? '****' : 'none'
        });
        return res.status(401).json({ error: 'Invalid API secret' });
    }
    logger.trace(`🔓 AUTH SUCCESS`, { traceId: req.traceId, path: req.path });
    next();
}

app.use((err, req, res, next) => {
    const status = err.status || 500;
    logger.error(`💥 REQUEST ERROR`, {
        traceId: req.traceId,
        path: req.path,
        method: req.method,
        status,
        error: err.message,
        stack: err.stack
    });
    res.status(status).json({
        error: err.message || 'Internal server error',
        timestamp: new Date().toISOString()
    });
});

// ============================================
// API ENDPOINTS
// ============================================

app.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();
    const stats = sessionManager.getStats();
    const now = new Date().toISOString();
    
    logger.info(`💚 HEALTH CHECK`, {
        traceId: req.traceId,
        sessions: stats.totalSessions,
        activeExecutions: stats.activeExecutions,
        queued: stats.queuedExecutions
    });
    
    res.json({
        status: 'healthy',
        version: '2.0.0',
        activeSessions: stats.totalSessions,
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
        completedExecutions: stats.completedExecutions,
        activeExecutions: stats.activeExecutions,
        queuedExecutions: stats.queuedExecutions,
        uptime: process.uptime(),
        memoryUsage: {
            rss: formatMemory(memUsage.rss),
            heapTotal: formatMemory(memUsage.heapTotal),
            heapUsed: formatMemory(memUsage.heapUsed),
            external: formatMemory(memUsage.external),
            arrayBuffers: formatMemory(memUsage.arrayBuffers)
        },
        timestamp: now,
        colabBinary: colab.binary,
        usePythonModule: colab.usePythonModule,
        hasAuthToken: !!CONFIG.COLAB_AUTH_TOKEN,
        nodeEnv: CONFIG.NODE_ENV
    });
});

app.get('/health/simple', (req, res) => {
    const stats = sessionManager.getStats();
    res.json({
        status: 'up',
        timestamp: new Date().toISOString(),
        sessions: stats.totalSessions
    });
});

app.get('/debug/sessions', authMiddleware, async (req, res) => {
    logger.info(`🔍 DEBUG SESSIONS LIST`, { traceId: req.traceId });
    
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
    logger.info(`🔍 DEBUG SESSION DETAIL`, { traceId: req.traceId, sessionId: sessionId.substring(0, 16) });
    
    const session = sessionManager.sessions.get(sessionId);
    
    if (!session) {
        logger.warn(`❌ SESSION NOT FOUND`, { sessionId: sessionId.substring(0, 16) });
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

app.post('/start', authMiddleware, async (req, res, next) => {
    const traceId = req.traceId;
    logger.info(`🆕 SESSION CREATE REQUEST`, { traceId });
    
    try {
        if (sessionManager.sessions.size >= CONFIG.MAX_SESSIONS) {
            logger.warn(`⚠️ MAX SESSIONS REACHED`, {
                traceId,
                current: sessionManager.sessions.size,
                max: CONFIG.MAX_SESSIONS
            });
            
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
                logger.info(`🗑️ KILLING OLDEST SESSION`, {
                    traceId,
                    sessionId: oldestSessionId.substring(0, 16),
                    colabSession: session.colabSession,
                    idleTime: Math.floor((Date.now() - session.lastActivity) / 60000) + 'm'
                });
                try {
                    await colab.run(['stop', '-s', session.colabSession], 10000);
                } catch (error) {
                    logger.warn(`⚠️ Could not stop session remotely`, { error: error.message });
                }
                await sessionManager.cleanupSessionFolder(oldestSessionId);
                sessionManager.sessions.delete(oldestSessionId);
                logger.info(`✅ REMOVED OLDEST SESSION`, { sessionId: oldestSessionId.substring(0, 16) });
            }
        }

        const sessionId = generateSessionId();
        const colabSessionName = `colab_${sessionId.substring(0, 12)}`;

        logger.info(`📝 CREATING NEW SESSION`, {
            traceId,
            sessionId: sessionId.substring(0, 16),
            colabSession: colabSessionName
        });

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
        
        logger.debug(`📁 Session data initialized`, { sessionId: sessionId.substring(0, 16), dataFile });
        
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

        logger.sessionCreated(sessionId, colabSessionName, sessionManager.sessions.size);

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
        logger.error(`❌ SESSION CREATION FAILED`, {
            traceId,
            error: error.message,
            stack: error.stack
        });
        next(new Error('Failed to create session'));
    }
});

app.post('/keepalive', authMiddleware, async (req, res, next) => {
    const { sessionId } = req.body;
    const traceId = req.traceId;
    
    if (!sessionId) {
        logger.warn(`⚠️ KEEPALIVE: NO SESSION ID`, { traceId });
        return res.status(400).json({ error: 'sessionId required' });
    }

    logger.debug(`💓 KEEPALIVE REQUEST`, {
        traceId,
        sessionId: sessionId.substring(0, 16)
    });

    const session = sessionManager.sessions.get(sessionId);
    if (!session) {
        logger.warn(`⚠️ KEEPALIVE: SESSION NOT FOUND`, {
            traceId,
            sessionId: sessionId.substring(0, 16)
        });
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        await colab.run(['sessions'], 10000);
        session.lastActivity = Date.now();
        sessionManager.sessions.set(sessionId, session);
        logger.debug(`✅ KEEPALIVE SUCCESS`, {
            traceId,
            sessionId: sessionId.substring(0, 16),
            lastActivity: new Date(session.lastActivity).toISOString()
        });
        res.json({ success: true, message: 'Session kept alive' });
    } catch (error) {
        logger.error(`❌ KEEPALIVE FAILED`, {
            traceId,
            sessionId: sessionId.substring(0, 16),
            error: error.message
        });
        res.status(500).json({ error: 'Keepalive failed', details: error.message });
    }
});

app.post('/run', authMiddleware, async (req, res, next) => {
    const { sessionId, code, cellNo } = req.body;
    const traceId = req.traceId;
    
    if (!sessionId || !code || cellNo === undefined) {
        logger.warn(`⚠️ RUN: MISSING FIELDS`, {
            traceId,
            hasSessionId: !!sessionId,
            hasCode: !!code,
            hasCellNo: cellNo !== undefined
        });
        return res.status(400).json({ error: 'Missing required fields: sessionId, code, cellNo' });
    }

    logger.info(`▶️ RUN REQUEST`, {
        traceId,
        sessionId: sessionId.substring(0, 16),
        cellNo,
        codeLength: code.length
    });

    const session = sessionManager.sessions.get(sessionId);
    if (!session) {
        logger.warn(`⚠️ RUN: SESSION NOT FOUND`, {
            traceId,
            sessionId: sessionId.substring(0, 16)
        });
        return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status === 'busy') {
        logger.sessionBusy(sessionId, session.currentExecution?.executionId);
        return res.status(409).json({ 
            error: 'Session busy',
            currentExecution: session.currentExecution
        });
    }

    const executionId = generateExecutionId();
    const validCellNo = parseInt(cellNo, 10);

    logger.executionStarted(sessionId, executionId, validCellNo, code);

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
        code: getCodeSnippet(code, 200),
        status: 'started'
    };
    await sessionManager.appendSessionData(sessionId, cellStartData);

    backgroundExecution(sessionId, validCellNo, code, executionId, colab, sessionManager);

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
    const traceId = req.traceId;
    
    if (!sessionId || !executionId) {
        logger.warn(`⚠️ STATUS: MISSING FIELDS`, { traceId });
        return res.status(400).json({ error: 'Missing required fields: sessionId, executionId' });
    }

    logger.trace(`📊 STATUS POLL`, {
        traceId,
        sessionId: sessionId.substring(0, 16),
        executionId: executionId.substring(0, 16)
    });

    if (sessionManager.completedExecutions.has(executionId)) {
        const record = sessionManager.completedExecutions.get(executionId);
        logger.trace(`✅ STATUS: COMPLETED`, {
            traceId,
            executionId: executionId.substring(0, 16),
            status: record.status
        });
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
        logger.trace(`🔄 STATUS: RUNNING`, {
            traceId,
            executionId: executionId.substring(0, 16),
            elapsed: Math.floor(elapsed / 1000) + 's'
        });
        return res.json({
            status: 'running',
            elapsed: elapsed,
            partialOutput: (active.stdout || '').substring(0, 10000),
            partialError: (active.stderr || '').substring(0, 1000)
        });
    }

    const session = sessionManager.sessions.get(sessionId);
    if (session && session.currentExecution?.executionId === executionId) {
        const elapsed = Date.now() - session.currentExecution.startedAt;
        logger.trace(`🔄 STATUS: RUNNING (from session)`, {
            traceId,
            executionId: executionId.substring(0, 16),
            elapsed: Math.floor(elapsed / 1000) + 's'
        });
        return res.json({
            status: 'running',
            elapsed: elapsed,
            partialOutput: session.currentExecution.partialOutput || '',
            partialError: session.currentExecution.partialError || ''
        });
    }

    logger.trace(`❓ STATUS: NOT FOUND`, {
        traceId,
        executionId: executionId.substring(0, 16)
    });
    res.json({ 
        status: 'not_found',
        message: 'Execution not found or already completed'
    });
});

app.post('/status/ack', authMiddleware, async (req, res) => {
    const { executionId } = req.body;
    const traceId = req.traceId;
    
    if (executionId && sessionManager.completedExecutions.has(executionId)) {
        sessionManager.completedExecutions.delete(executionId);
        logger.debug(`✅ STATUS ACKNOWLEDGED`, { traceId, executionId: executionId.substring(0, 16) });
        res.json({ success: true, message: 'Acknowledged' });
    } else {
        logger.debug(`❓ STATUS ACK: NOT FOUND`, { traceId, executionId: executionId?.substring(0, 16) });
        res.json({ success: false, message: 'Execution not found' });
    }
});

app.delete('/session/:sessionId', authMiddleware, async (req, res, next) => {
    const { sessionId } = req.params;
    const traceId = req.traceId;
    
    logger.info(`🗑️ SESSION DELETE REQUEST`, {
        traceId,
        sessionId: sessionId.substring(0, 16)
    });

    const session = sessionManager.sessions.get(sessionId);
    if (!session) {
        logger.warn(`⚠️ DELETE: SESSION NOT FOUND`, {
            traceId,
            sessionId: sessionId.substring(0, 16)
        });
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        await colab.run(['stop', '-s', session.colabSession], 30000);
        await sessionManager.cleanupSessionFolder(sessionId);
        sessionManager.sessions.delete(sessionId);
        logger.sessionDeleted(sessionId, 'manual');
        res.json({ success: true, message: 'Session terminated' });
    } catch (error) {
        logger.warn(`⚠️ SESSION DELETE PARTIAL`, {
            traceId,
            sessionId: sessionId.substring(0, 16),
            error: error.message
        });
        await sessionManager.cleanupSessionFolder(sessionId);
        sessionManager.sessions.delete(sessionId);
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
    logger.warn(`❓ 404 NOT FOUND`, {
        method: req.method,
        path: req.path,
        ip: req.ip || req.get('x-forwarded-for') || 'unknown'
    });
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
    
    logger.info(`🛑 RECEIVED ${signal}, STARTING GRACEFUL SHUTDOWN...`);
    
    const stats = sessionManager.getStats();
    logger.info(`📊 SHUTDOWN STATS`, {
        activeSessions: stats.totalSessions,
        activeExecutions: stats.activeExecutions,
        queued: stats.queuedExecutions
    });
    
    for (const sessionId of sessionManager.sessions.keys()) {
        try {
            const session = sessionManager.sessions.get(sessionId);
            if (session) {
                logger.debug(`🧹 Cleaning session`, { sessionId: sessionId.substring(0, 16) });
                await colab.run(['stop', '-s', session.colabSession], 10000);
                await sessionManager.cleanupSessionFolder(sessionId);
                sessionManager.sessions.delete(sessionId);
            }
        } catch (error) {
            logger.warn(`⚠️ Failed to clean up session`, {
                sessionId: sessionId.substring(0, 16),
                error: error.message
            });
        }
    }
    
    logger.info(`✅ GRACEFUL SHUTDOWN COMPLETE`);
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
    logger.error(`💥 UNCAUGHT EXCEPTION`, {
        error: error.message,
        stack: error.stack
    });
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason) => {
    logger.error(`💥 UNHANDLED REJECTION`, { reason });
});

// ============================================
// INITIALIZATION
// ============================================

const colab = new ColabBinaryManager();
const sessionManager = new SessionManager(CONFIG.SESSIONS_BASE_DIR);

async function init() {
    try {
        logger.info('🚀 INITIALIZING COLAB ORCHESTRATOR v2.0 (API-Only)');
        logger.info(`📊 LOG LEVEL: ${CONFIG.LOG_LEVEL}`);
        
        await colab.initialize();
        
        await fs.mkdir(CONFIG.SESSIONS_BASE_DIR, { recursive: true });
        logger.info(`📁 SESSIONS DIRECTORY: ${CONFIG.SESSIONS_BASE_DIR}`);
        
        await setupColabAuth();
        await colab.testConnection();
        
        sessionManager.startCleanupInterval();
        setTimeout(() => sessionManager.cleanupIdleSessions(colab), 60 * 60 * 1000);
        setInterval(() => sessionManager.cleanupHangingProcesses(), 5 * 60 * 1000);
        
        const PORT = CONFIG.PORT;
        app.listen(PORT, () => {
            console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║  🚀  COLAB ORCHESTRATOR v2.0 (API-Only)                         ║
╠═══════════════════════════════════════════════════════════════════╣
║  📡  Port: ${PORT}                                                       ║
║  📁  Sessions: ${CONFIG.SESSIONS_BASE_DIR}                ║
║  🔧  Binary: ${colab.binary} ${colab.usePythonModule ? '(-m colab_cli)' : ''}
║  📊  Max Sessions: ${CONFIG.MAX_SESSIONS}                                               ║
║  🔐  Auth: ${CONFIG.COLAB_AUTH_TOKEN ? '✅ Configured' : '❌ Not configured'}                                      ║
║  ⏰  Session Timeout: ${CONFIG.SESSION_TIMEOUT / 1000 / 60 / 60}h                                     ║
║  ⏱️   Execution Timeout: ${CONFIG.EXECUTION_TIMEOUT / 60}m                                       ║
║  🔒  CORS: ${allowedOrigins.length} allowed origins                                  ║
║  🌐  Environment: ${CONFIG.NODE_ENV}                                                 ║
║  📦  API-Only: No static files served                                    ║
║  📝  Log Level: ${CONFIG.LOG_LEVEL}                                                 ║
╚═══════════════════════════════════════════════════════════════════╝
            `);
            
            logger.info(`🌐 API server running on http://localhost:${PORT}`);
            logger.info(`🔑 API Secret: ${CONFIG.API_SECRET === 'kushalkumarjthegreat' ? '⚠️ Default' : '✅ Custom'}`);
            logger.info(`📊 Health check: http://localhost:${PORT}/health`);
            logger.info(`📋 API docs: http://localhost:${PORT}/ (shows endpoints)`);
            logger.info(`🔍 Debug: Set LOG_LEVEL=trace for maximum verbosity`);
        });
        
    } catch (error) {
        logger.error('❌ FATAL INITIALIZATION ERROR', {
            error: error.message,
            stack: error.stack
        });
        process.exit(1);
    }
}

init();
