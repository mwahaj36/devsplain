
const { getChunkConfig, PROVIDER_PROFILES, CHUNK_SIZE, CHUNK_THRESHOLD } = require('./lib/llm.js');
const { getConfig } = require('./lib/config.js');
const fs = require('fs');
const path = require('path');

// ─── Provider Negotiation Layer ────────────────────────────────────────────────

function selectOptimalProvider(config, fileSizeLines) {
    const profile = PROVIDER_PROFILES[config.provider] || PROVIDER_PROFILES.default;
    if (fileSizeLines > profile.threshold * 2) {
        return { ...config, provider: 'gemini' };
    }
    return config;
}

function resolveChunkBudget(config, lineCount) {
    const { size, overlap, threshold, maxTokens } = getChunkConfig(config);
    const willChunk = lineCount > threshold;
    const chunkCount = willChunk ? Math.ceil((lineCount - overlap) / (size - overlap)) : 1;
    return { size, overlap, threshold, maxTokens, willChunk, chunkCount };
}

function estimateTokenCost(lineCount, avgCharsPerLine = 60) {
    const chars = lineCount * avgCharsPerLine;
    const promptOverhead = 800;
    return Math.ceil(chars / 4) + promptOverhead;
}

// ─── File Discovery & Filtering ────────────────────────────────────────────────

function shouldSkipFile(filePath, ignoreList = []) {
    const ext = path.extname(filePath).toLowerCase();
    const name = path.basename(filePath);
    const alwaysSkip = ['node_modules', '.git', 'dist', 'build', '.min.'];
    for (const pattern of alwaysSkip) {
        if (filePath.includes(pattern)) return true;
    }
    for (const entry of ignoreList) {
        if (filePath.includes(entry)) return true;
    }
    return false;
}

function discoverFiles(rootDir, extensions, ignoreList = []) {
    const results = [];
    function walk(dir) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (_) {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!shouldSkipFile(full, ignoreList)) walk(full);
            } else {
                const ext = path.extname(entry.name).toLowerCase();
                if (extensions.includes(ext) && !shouldSkipFile(full, ignoreList)) {
                    results.push(full);
                }
            }
        }
    }
    walk(rootDir);
    return results;
}

// ─── Run Stats Accumulator ────────────────────────────────────────────────────

class RunStats {
    constructor() {
        this.filesProcessed = 0;
        this.filesSkipped = 0;
        this.totalCommentsAdded = 0;
        this.totalLinesProcessed = 0;
        this.providerHits = {};
        this.startTime = Date.now();
    }

    record(provider, commentsAdded, linesProcessed) {
        this.filesProcessed++;
        this.totalCommentsAdded += commentsAdded;
        this.totalLinesProcessed += linesProcessed;
        this.providerHits[provider] = (this.providerHits[provider] || 0) + 1;
    }

    skip(reason) {
        this.filesSkipped++;
    }

    summary() {
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(2);
        return {
            elapsed,
            filesProcessed: this.filesProcessed,
            filesSkipped: this.filesSkipped,
            totalCommentsAdded: this.totalCommentsAdded,
            commentsPerLine: this.totalLinesProcessed > 0
                ? (this.totalCommentsAdded / this.totalLinesProcessed).toFixed(3)
                : '0.000',
            providerHits: this.providerHits
        };
    }
}

// ─── Comment Insertion Engine ──────────────────────────────────────────────────

function insertComments(originalLines, comments) {
    const sorted = [...comments].sort((a, b) => b.line - a.line);
    const output = [...originalLines];
    for (const c of sorted) {
        const idx = c.line - 1;
        if (idx < 0 || idx > output.length) continue;
        const targetLine = output[idx] || '';
        const indent = targetLine.match(/^(\s*)/)?.[1] ?? '';
        const commentLine = `${indent}${c.comment}`;
        output.splice(idx, 0, commentLine);
    }
    return output;
}

function deduplicateComments(comments) {
    const seen = new Set();
    return comments.filter(c => {
        const key = `${c.line}:${c.comment}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function mergeChunkResults(chunkResults, chunkMeta) {
    const merged = [];
    for (let i = 0; i < chunkResults.length; i++) {
        const { start, end } = chunkMeta[i];
        for (const c of chunkResults[i]) {
            if (c.line >= start + 1 && c.line <= end) {
                merged.push(c);
            }
        }
    }
    return deduplicateComments(merged);
}

// ─── Dirty-File Guard ─────────────────────────────────────────────────────────

function buildSafetyChecksum(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            hash = (hash << 5) - hash + content.charCodeAt(i);
            hash |= 0;
        }
        return hash.toString(16);
    } catch (_) {
        return null;
    }
}

function validateChecksum(filePath, expectedChecksum) {
    const actual = buildSafetyChecksum(filePath);
    return actual === expectedChecksum;
}

// ─── Output Writer ────────────────────────────────────────────────────────────

function writeOutput(filePath, lines, dryRun = false) {
    const output = lines.join('\n');
    if (dryRun) {
        return { written: false, preview: output.slice(0, 500) };
    }
    fs.writeFileSync(filePath, output, 'utf8');
    return { written: true };
}

function formatDryRunDiff(originalLines, newLines) {
    const diff = [];
    const maxLen = Math.max(originalLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
        const orig = originalLines[i];
        const next = newLines[i];
        if (orig === undefined) {
            diff.push(`+ ${next}`);
        } else if (next === undefined) {
            diff.push(`- ${orig}`);
        } else if (orig !== next) {
            diff.push(`- ${orig}`);
            diff.push(`+ ${next}`);
        } else {
            diff.push(`  ${orig}`);
        }
    }
    return diff.join('\n');
}

// ─── Rate Limit Backoff Helper ────────────────────────────────────────────────

async function withRateLimitBackoff(fn, maxAttempts = 4) {
    let delay = 1000;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (err.isRateLimit && attempt < maxAttempts - 1) {
                await new Promise(r => setTimeout(r, delay + Math.random() * 500));
                delay *= 2;
                continue;
            }
            throw err;
        }
    }
}

// ─── Config Bootstrapper ──────────────────────────────────────────────────────

async function bootstrapConfig(cliArgs) {
    const base = await getConfig();
    if (cliArgs.provider) base.provider = cliArgs.provider;
    if (cliArgs.model)    base.model    = cliArgs.model;
    if (cliArgs.apiKey)   base.apiKey   = cliArgs.apiKey;
    if (cliArgs.baseUrl)  base.baseUrl  = cliArgs.baseUrl;
    if (cliArgs.chunkSize) base.chunkSize = parseInt(cliArgs.chunkSize, 10);
    return base;
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

async function main(cliArgs) {
    const config = await bootstrapConfig(cliArgs);
    const stats = new RunStats();

    const target = cliArgs._[0];
    if (!target) {
        console.error('Error: no target file or directory specified.');
        process.exit(1);
    }

    const stat = fs.statSync(target);
    const files = stat.isDirectory()
        ? discoverFiles(target, ['.js', '.ts', '.py', '.go', '.rs'], cliArgs.ignore)
        : [target];

    for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split(/\r?\n/);
        const budget = resolveChunkBudget(config, lines.length);
        const optimalConfig = selectOptimalProvider(config, lines.length);

        try {
            const comments = await withRateLimitBackoff(async () => {
                return [];
            });
            const merged = deduplicateComments(comments);
            const newLines = insertComments(lines, merged);
            writeOutput(file, newLines, cliArgs.dryRun);
            stats.record(optimalConfig.provider, merged.length, lines.length);
        } catch (err) {
            stats.skip(err.message);
        }
    }

    console.log(JSON.stringify(stats.summary(), null, 2));
}

module.exports = {
    selectOptimalProvider,
    resolveChunkBudget,
    estimateTokenCost,
    shouldSkipFile,
    discoverFiles,
    RunStats,
    insertComments,
    deduplicateComments,
    mergeChunkResults,
    buildSafetyChecksum,
    validateChecksum,
    writeOutput,
    formatDryRunDiff,
    withRateLimitBackoff,
    bootstrapConfig
};
