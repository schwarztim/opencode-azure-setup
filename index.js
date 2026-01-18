#!/usr/bin/env node
/**
 * OpenCode Azure Setup
 * Cross-platform installer for Azure OpenAI configuration
 *
 * Usage:
 *   npx opencode-azure-setup
 *   npx opencode-azure-setup -y    # Non-interactive (use existing config)
 *   node install-azure.js
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import https from 'https';
import os from 'os';

// Parse args
const args = process.argv.slice(2);
const nonInteractive = args.includes('-y') || args.includes('--yes') || args.includes('--non-interactive');

// Colors
const colors = {
  blue: '\x1b[34m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

const logo = `
   ___                   ____          _
  / _ \\ _ __   ___ _ __ / ___|___   __| | ___
 | | | | '_ \\ / _ \\ '_ \\ |   / _ \\ / _\` |/ _ \\
 | |_| | |_) |  __/ | | | |__| (_) | (_| |  __/
  \\___/| .__/ \\___|_| |_|\\____\\___/ \\__,_|\\___|
       |_|                 Azure Edition
`;

function getConfigPath() {
  return path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
}

// Load existing config if it exists
function loadExistingConfig() {
  const configPath = getConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch {
    // Config doesn't exist or is invalid
  }
  return null;
}

// Extract existing Azure settings from config
function getExistingAzureSettings(config) {
  if (!config?.provider?.azure?.options) return null;

  const azure = config.provider.azure;
  const opts = azure.options;
  const modelName = Object.keys(azure.models || {})[0] || 'model-router';

  return {
    baseUrl: opts.baseURL || '',
    apiKey: opts.apiKey || '',
    deployment: modelName,
    apiVersion: opts.apiVersion || '2025-01-01-preview',
  };
}

// Only create readline interface if not in non-interactive mode
let rl = null;
function getRl() {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }
  return rl;
}

function ask(question, defaultValue = '') {
  return new Promise((resolve) => {
    const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    getRl().question(prompt, (answer) => resolve(answer || defaultValue));
  });
}

function askPassword(question, existingValue = '') {
  return new Promise((resolve) => {
    if (existingValue) {
      const masked = existingValue.slice(0, 4) + '...' + existingValue.slice(-4);
      process.stdout.write(`${question} [${masked}]: `);
    } else {
      process.stdout.write(`${question}: `);
    }

    if (process.stdin.isTTY) {
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      let password = '';
      const onData = (char) => {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          stdin.setRawMode(false);
          stdin.removeListener('data', onData);
          console.log();
          // If user just pressed Enter and there's an existing value, use it
          resolve(password || existingValue);
        } else if (char === '\u0003') {
          process.exit();
        } else if (char === '\u007F' || char === '\b') {
          password = password.slice(0, -1);
        } else {
          password += char;
        }
      };
      stdin.on('data', onData);
    } else {
      rl.question('', (answer) => resolve(answer || existingValue));
    }
  });
}

// Fetch latest defaults from GitHub (falls back to hardcoded if offline)
async function fetchDefaults() {
  const defaults = {
    deployment: 'model-router',
    apiVersion: '2025-01-01-preview',
  };

  try {
    const res = await fetch('https://raw.githubusercontent.com/schwarztim/opencode/dev/azure-defaults.json', {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.apiVersion) defaults.apiVersion = data.apiVersion;
      if (data.deployment) defaults.deployment = data.deployment;
    }
  } catch {
    // Offline or fetch failed - use hardcoded defaults
  }

  return defaults;
}

// Parse Azure endpoint - handles both full URL and base URL
function parseAzureEndpoint(input, defaults) {
  const result = {
    baseUrl: '',
    deployment: defaults.deployment,
    apiVersion: defaults.apiVersion,
  };

  try {
    const url = new URL(input);

    // Extract deployment from path: /openai/deployments/{deployment}/...
    const deploymentMatch = url.pathname.match(/\/deployments\/([^/]+)/);
    if (deploymentMatch) {
      result.deployment = deploymentMatch[1];
    }

    // Extract api-version from query params
    const apiVersion = url.searchParams.get('api-version');
    if (apiVersion) {
      result.apiVersion = apiVersion;
    }

    // Build base URL: https://host/openai
    const pathParts = url.pathname.split('/');
    const openaiIndex = pathParts.indexOf('openai');
    if (openaiIndex !== -1) {
      url.pathname = pathParts.slice(0, openaiIndex + 1).join('/');
    } else {
      url.pathname = '/openai';
    }
    url.search = '';
    result.baseUrl = url.toString().replace(/\/$/, '');

  } catch {
    // Not a valid URL, assume it's just the host
    let cleaned = input.replace(/\/$/, '');
    if (!cleaned.startsWith('https://')) {
      cleaned = 'https://' + cleaned;
    }
    if (!cleaned.endsWith('/openai')) {
      cleaned += '/openai';
    }
    result.baseUrl = cleaned;
  }

  return result;
}

async function testConnection(endpoint, apiKey, deployment, apiVersion) {
  return new Promise((resolve) => {
    const url = new URL(`${endpoint}/deployments/${deployment}/chat/completions?api-version=${apiVersion}`);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
    };

    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }],
      max_completion_tokens: 5,
    });

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: data }));
    });

    req.on('error', (e) => resolve({ ok: false, status: 0, body: e.message }));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ ok: false, status: 0, body: 'Timeout' });
    });

    req.write(body);
    req.end();
  });
}

async function main() {
  console.log(colors.blue + logo + colors.reset);
  console.log(colors.blue + 'Azure OpenAI Setup' + colors.reset);
  console.log('─'.repeat(40));
  console.log();

  // Load existing config
  const existingConfig = loadExistingConfig();
  const existingAzure = getExistingAzureSettings(existingConfig);

  // Fetch latest defaults (non-blocking, falls back to hardcoded)
  const defaults = await fetchDefaults();

  // If existing config found, show current values
  if (existingAzure && existingAzure.baseUrl) {
    console.log(colors.green + '✓ Existing configuration found' + colors.reset);
    if (nonInteractive) {
      console.log(colors.dim + '  Using existing values (non-interactive mode)' + colors.reset);
    } else {
      console.log(colors.dim + '  Press Enter to keep current values, or type new ones' + colors.reset);
    }
    console.log();
  }

  // Endpoint - accepts full URL or just the base
  let baseUrl, deployment, apiVersion, apiKey;

  // Non-interactive mode with existing config - skip all prompts
  if (nonInteractive && existingAzure?.baseUrl && existingAzure?.apiKey) {
    baseUrl = existingAzure.baseUrl;
    deployment = existingAzure.deployment;
    apiVersion = existingAzure.apiVersion;
    apiKey = existingAzure.apiKey;
    console.log(colors.dim + `  Endpoint: ${baseUrl}` + colors.reset);
    console.log(colors.dim + `  Deployment: ${deployment}` + colors.reset);
  } else if (nonInteractive && !existingAzure?.baseUrl) {
    console.log(colors.red + 'No existing config found. Run without -y flag to configure.' + colors.reset);
    process.exit(1);
  } else if (existingAzure?.baseUrl) {
    console.log('Azure OpenAI Endpoint');
    const rawEndpoint = await ask('Endpoint', existingAzure.baseUrl);

    if (rawEndpoint === existingAzure.baseUrl) {
      // User kept existing - use existing parsed values
      baseUrl = existingAzure.baseUrl;
      deployment = existingAzure.deployment;
      apiVersion = existingAzure.apiVersion;
    } else {
      // User entered new value - parse it
      const parsed = parseAzureEndpoint(rawEndpoint, defaults);
      baseUrl = parsed.baseUrl;
      deployment = parsed.deployment;
      apiVersion = parsed.apiVersion;
    }

    // API Key
    console.log();
    apiKey = await askPassword('API Key', existingAzure?.apiKey || '');
    if (!apiKey) {
      console.log(colors.red + 'API Key is required' + colors.reset);
      process.exit(1);
    }

    // Deployment (only ask if not using existing)
    if (existingAzure?.deployment && deployment === existingAzure.deployment) {
      // Keep existing
    } else {
      console.log();
      deployment = await ask('Deployment name', deployment);
    }
  } else {
    console.log('Paste your Azure OpenAI endpoint');
    console.log(colors.dim + 'Tip: You can paste the full URL from Azure Portal - we\'ll extract what we need' + colors.reset);
    console.log();
    const rawEndpoint = await ask('Endpoint');

    if (!rawEndpoint) {
      console.log(colors.red + 'Endpoint is required' + colors.reset);
      process.exit(1);
    }

    const parsed = parseAzureEndpoint(rawEndpoint, defaults);
    baseUrl = parsed.baseUrl;
    deployment = parsed.deployment;
    apiVersion = parsed.apiVersion;

    // API Key
    console.log();
    apiKey = await askPassword('API Key');
    if (!apiKey) {
      console.log(colors.red + 'API Key is required' + colors.reset);
      process.exit(1);
    }

    console.log();
    deployment = await ask('Deployment name', deployment);
  }

  console.log();
  console.log(colors.blue + 'Testing connection...' + colors.reset);
  console.log(colors.dim + `  ${baseUrl}/deployments/${deployment}` + colors.reset);

  let result = await testConnection(baseUrl, apiKey, deployment, apiVersion);

  if (result.ok) {
    console.log(colors.green + '✓ Connection successful!' + colors.reset);
  } else {
    console.log(colors.red + `✗ Connection failed (${result.status || 'error'})` + colors.reset);
    if (result.body) {
      try {
        const err = JSON.parse(result.body);
        console.log(colors.dim + (err.error?.message || result.body.slice(0, 200)) + colors.reset);
      } catch {
        console.log(colors.dim + result.body.slice(0, 200) + colors.reset);
      }
    }

    if (nonInteractive) {
      // Non-interactive mode - just continue with existing config
      console.log(colors.yellow + '⚠ Continuing anyway (non-interactive mode)' + colors.reset);
    } else {
      // Offer to edit settings if connection failed
      console.log();
      console.log(colors.yellow + 'Let\'s try different settings:' + colors.reset);
      deployment = await ask('Deployment name', deployment);
      apiVersion = await ask('API Version', apiVersion);

      console.log();
      console.log(colors.blue + 'Retrying...' + colors.reset);
      result = await testConnection(baseUrl, apiKey, deployment, apiVersion);

      if (result.ok) {
        console.log(colors.green + '✓ Connection successful!' + colors.reset);
      } else {
        console.log(colors.red + `✗ Still failing (${result.status || 'error'})` + colors.reset);
        const cont = await ask('Save config anyway? (y/N)', 'N');
        if (cont.toLowerCase() !== 'y') process.exit(1);
      }
    }
  }

  // Create config - preserve existing settings like agents, permissions
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  // Start with existing config or empty object
  const config = existingConfig || {};

  // Update schema and model
  config.$schema = 'https://opencode.ai/config.json';
  config.model = `azure/${deployment}`;

  // Update Azure provider settings
  config.provider = config.provider || {};
  config.provider.azure = {
    npm: '@ai-sdk/azure',
    name: 'Azure OpenAI',
    options: {
      baseURL: baseUrl,
      apiKey: apiKey,
      useDeploymentBasedUrls: true,
      apiVersion: apiVersion,
    },
    models: {
      [deployment]: {
        name: deployment,
        limit: { context: 200000, output: 16384 },
      },
    },
  };

  // Install and configure MCP Marketplace
  console.log();
  console.log(colors.blue + 'Setting up MCP Marketplace...' + colors.reset);

  const mcpDir = path.join(os.homedir(), '.config', 'opencode', 'mcps', 'mcp-marketplace');
  fs.mkdirSync(mcpDir, { recursive: true });

  try {
    const { execFileSync } = await import('child_process');

    // Initialize package.json if not exists
    const pkgPath = path.join(mcpDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      fs.writeFileSync(pkgPath, JSON.stringify({ name: 'opencode-mcps', version: '1.0.0', type: 'module' }, null, 2));
    }

    // Install mcp-marketplace package locally (no sudo needed)
    execFileSync('npm', ['install', 'opencode-mcp-marketplace@latest'], { cwd: mcpDir, stdio: 'pipe' });

    const mcpPath = path.join(mcpDir, 'node_modules', 'opencode-mcp-marketplace', 'dist', 'index.js');

    // Add to config
    config.mcp = config.mcp || {};
    config.mcp['mcp-marketplace'] = {
      type: 'local',
      command: ['node', mcpPath],
    };

    console.log(colors.green + '✓ MCP Marketplace installed!' + colors.reset);
  } catch (e) {
    console.log(colors.yellow + '⚠ MCP Marketplace install skipped (npm not available or failed)' + colors.reset);
    console.log(colors.dim + '  You can install manually: npm install -g opencode-mcp-marketplace' + colors.reset);
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  console.log();
  console.log(colors.green + '✓ Configuration saved!' + colors.reset);
  console.log(colors.dim + `  ${configPath}` + colors.reset);

  // Install opencode binary
  console.log();
  console.log(colors.blue + 'Installing opencode binary...' + colors.reset);

  try {
    const platform = process.platform === 'win32' ? 'windows' : process.platform;
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const binaryName = `opencode-${platform}-${arch}`;

    // Get latest release from GitHub
    const releaseUrl = 'https://api.github.com/repos/schwarztim/opencode/releases/latest';
    const releaseRes = await fetch(releaseUrl, {
      headers: { 'User-Agent': 'opencode-azure-setup' },
      signal: AbortSignal.timeout(10000),
    });

    if (!releaseRes.ok) throw new Error(`Failed to fetch release: ${releaseRes.status}`);
    const release = await releaseRes.json();

    // Find the matching asset (handles -bin suffix for non-windows)
    const asset = release.assets.find(a =>
      a.name === binaryName ||
      a.name === `${binaryName}.exe` ||
      a.name === `${binaryName}-bin`
    );
    if (!asset) throw new Error(`No binary found for ${binaryName}`);

    console.log(colors.dim + `  Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)...` + colors.reset);

    // Download binary
    const binRes = await fetch(asset.browser_download_url, {
      headers: { 'User-Agent': 'opencode-azure-setup' },
      signal: AbortSignal.timeout(120000),
    });

    if (!binRes.ok) throw new Error(`Failed to download: ${binRes.status}`);
    const binData = await binRes.arrayBuffer();

    // Install to ~/.local/bin
    const binDir = path.join(os.homedir(), '.local', 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    const binPath = path.join(binDir, platform === 'windows' ? 'opencode.exe' : 'opencode');
    fs.writeFileSync(binPath, Buffer.from(binData));
    fs.chmodSync(binPath, 0o755);

    console.log(colors.green + '✓ opencode installed!' + colors.reset);
    console.log(colors.dim + `  ${binPath}` + colors.reset);

    // Check if ~/.local/bin is in PATH
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    if (!pathDirs.includes(binDir)) {
      console.log(colors.yellow + `  Add to PATH: export PATH="$HOME/.local/bin:$PATH"` + colors.reset);
    }
  } catch (e) {
    console.log(colors.yellow + '⚠ Binary install skipped: ' + e.message + colors.reset);
    console.log(colors.dim + '  You can install manually from: https://github.com/schwarztim/opencode/releases' + colors.reset);
  }

  // Show what was preserved
  if (existingConfig) {
    const preserved = [];
    if (existingConfig.agent) preserved.push('agents');
    if (existingConfig.permission) preserved.push('permissions');
    if (preserved.length > 0) {
      console.log(colors.dim + `  Preserved: ${preserved.join(', ')}` + colors.reset);
    }
  }

  console.log();
  console.log('─'.repeat(40));
  console.log(colors.green + 'You\'re all set! Run:' + colors.reset);
  console.log();
  console.log('    ' + colors.blue + 'opencode' + colors.reset);
  console.log();

  if (rl) rl.close();
}

main().catch((err) => {
  console.error(colors.red + 'Error: ' + err.message + colors.reset);
  process.exit(1);
});
