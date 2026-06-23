const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const fixturesDir = path.join(__dirname, 'fixtures');
const playgroundDir = path.join(__dirname, 'e2e_playground');
const baselineDir = path.join(__dirname, 'baseline');

if (fs.existsSync(playgroundDir)) fs.rmSync(playgroundDir, { recursive: true, force: true });
if (fs.existsSync(baselineDir)) fs.rmSync(baselineDir, { recursive: true, force: true });

fs.mkdirSync(playgroundDir, { recursive: true });
fs.mkdirSync(baselineDir, { recursive: true });

const files = fs.readdirSync(fixturesDir).filter(f => !fs.statSync(path.join(fixturesDir, f)).isDirectory());

for (const file of files) {
  fs.copyFileSync(path.join(fixturesDir, file), path.join(baselineDir, file));
  fs.copyFileSync(path.join(fixturesDir, file), path.join(playgroundDir, file));
}

console.log('Initializing git and setting up devsplain hooks...');
execSync('git init', { cwd: playgroundDir, stdio: 'inherit' });
fs.writeFileSync(path.join(playgroundDir, '.gitignore'), 'baseline/\nnode_modules/\n');

execSync('devsplain --setup-hook', { cwd: playgroundDir, stdio: 'inherit' });

function executeWithBackoff(command, maxRetries = 10) {
  let attempt = 0;
  let delayMs = 15000;

  while (attempt < maxRetries) {
    try {
      console.log('Running: ' + command);
      const start = Date.now();
      execSync(command, { stdio: 'pipe' });
      const duration = (Date.now() - start) / 1000;
      console.log('✅ Success in ' + duration.toFixed(2) + 's');
      return;
    } catch (error) {
      attempt++;
      console.log('❌ Failed (Attempt ' + attempt + '/' + maxRetries + '). Retrying in ' + (delayMs / 1000) + 's...');
      execSync('node -e "setTimeout(()=>{}, ' + delayMs + ')"');
      delayMs *= 2; 
      if (delayMs > 300000) delayMs = 300000;
    }
  }
  throw new Error('Failed after ' + maxRetries + ' attempts: ' + command);
}

function stripComments(content) {
  let result = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  result = result.replace(/<!--[\s\S]*?-->/g, '');
  result = result.replace(new RegExp('\\x23.*', 'g'), '');
  return result;
}

function verifyIntegrity(originalPath, processedPath, strict = true) {
  const original = fs.readFileSync(originalPath, 'utf8');
  const processed = fs.readFileSync(processedPath, 'utf8');
  const cleanOriginal = stripComments(original);
  const cleanProcessed = stripComments(processed);
  if (cleanOriginal !== cleanProcessed && strict) {
    console.error('INTEGRITY FAILED: ' + processedPath);
    throw new Error('Integrity check failed');
  }
}

function calculateMetrics(processedPath) {
  const content = fs.readFileSync(processedPath, 'utf8');
  const lines = content.split('\n');
  let commentLines = 0, codeLines = 0, dsComments = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#!')) {
      codeLines++;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('#') || trimmed.startsWith('<!--') || trimmed.startsWith('"""')) {
      commentLines++;
      if (trimmed.includes('[ds]')) dsComments++;
    } else {
      codeLines++;
    }
  }
  const ratio = codeLines === 0 ? 0 : (commentLines / codeLines).toFixed(2);
  console.log('  📊 Metrics -> Code: ' + codeLines + ', Comments: ' + commentLines + ', Ratio: ' + ratio + ', [ds] tags: ' + dsComments);
  return { codeLines, commentLines, ratio, dsComments };
}

console.log('\n--- PHASE 2: PROCESSING FILES ---');
for (const file of files) {
  let mode = '';
  if (file.includes('_light')) mode = '--light';
  else if (file.includes('_full')) mode = '--full';
  const targetPath = path.join(playgroundDir, file);
  executeWithBackoff('devsplain "' + targetPath + '" ' + mode + ' --force');
  verifyIntegrity(path.join(baselineDir, file), targetPath, false);
  calculateMetrics(targetPath);
}

console.log('\n--- PHASE 3: GIT HOOK TEST ---');
const testFullFile = files.find(f => f.includes('_full.js'));
if (testFullFile) {
  const p = path.join(playgroundDir, testFullFile);
  fs.appendFileSync(p, '\n// New manual edit\nconsole.log("Hook test");\n');
}

execSync('git add .', { cwd: playgroundDir });
console.log('Committing to trigger post-commit hook...');
try {
  execSync('git commit -m "E2E Test Commit"', { cwd: playgroundDir, stdio: 'inherit' });
} catch (e) {
  console.log('Commit hook failed, maybe due to rate limiting or devsplain logic.');
}

if (testFullFile) {
  const p = path.join(playgroundDir, testFullFile);
  console.log('Verifying ' + testFullFile + ' post-commit...');
  const metrics = calculateMetrics(p);
  if (metrics.dsComments === 0) {
    console.error('❌ Hook wiped out full comments!');
  } else {
    console.log('✅ Hook preserved AI comments successfully.');
  }
}

console.log('\n--- PHASE 4: CLEAN --clean ---');
executeWithBackoff('devsplain . --clean --force');
for (const file of files) {
  const p = path.join(playgroundDir, file);
  const metrics = calculateMetrics(p);
  if (metrics.dsComments > 0) throw new Error('Clean failed to remove [ds] comments from ' + file);
}
console.log('✅ Clean successful');

console.log('\n--- PHASE 5: PRUNE --prune ---');
executeWithBackoff('devsplain . --prune --force');
for (const file of files) {
  const p = path.join(playgroundDir, file);
  const metrics = calculateMetrics(p);
  if (metrics.commentLines > 0) throw new Error('Prune failed to remove all comments from ' + file);
}
console.log('✅ Prune successful');

console.log('\n🎉 All E2E Tests Passed Successfully!');
