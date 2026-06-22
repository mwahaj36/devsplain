const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const configPath = path.join(os.homedir(), '.devsplainrc');

/**
 * Retrieves configuration from environment variables or a local config file.
 * Runs a setup wizard if configuration is missing or forced.
 * @param {boolean} forceWizard - Whether to force the interactive setup.
 * @returns {Promise<Object>} The configuration object.
*/
async function getConfig(forceWizard = false) {
  // Priority 1: Check environment variables for configuration
  if (process.env.DEVSPLAIN_API_KEY || process.env.DEVSPLAIN_PROVIDER) {
    const provider = process.env.DEVSPLAIN_PROVIDER || 'gemini';
    const model = process.env.DEVSPLAIN_MODEL || (provider === 'gemini' ? 'gemini-2.0-flash' : 'llama-3.3-70b-versatile');
    const baseUrl = process.env.DEVSPLAIN_BASE_URL || (provider === 'gemini' ? null : 'https://api.groq.com/openai');
    return {
      provider,
      apiKey: process.env.DEVSPLAIN_API_KEY || '',
      model,
      baseUrl
    };
  }

  // Priority 2: Check for existing config file or run setup wizard
  if (!fs.existsSync(configPath) || forceWizard) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    // Promisify readline to allow async flow
    const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

    let config = null;
    let confirmed = false;

    // Loop until user confirms configuration choices
    while (!confirmed) {
      let baseUrl = "";
      let model = "";
      let provider = "";

      console.log("\nWhich AI Provider Do You want to use?");
      console.log("1. Groq (Free, Fast, Llama-3)");
      console.log("2. Gemini (Free Tier)");
      console.log("3. OpenAI (Paid)");
      console.log("4. Custom (Ollama, local, etc)");

      const choice = await askQuestion("Select (1-4): ");

      // Handle specific provider setup logic
      if (choice === '1') {
        provider = 'groq';
        baseUrl = 'https://api.groq.com/openai';
        console.log("\nGet your free Groq key here: https://console.groq.com/keys");
        const customModel = await askQuestion("Model name (press Enter for default 'llama-3.3-70b-versatile'): ");
        model = customModel.trim() || 'llama-3.3-70b-versatile';
      } else if (choice === '2') {
        provider = 'gemini';
        baseUrl = null;
        console.log("\nGet your free Gemini key here: https://aistudio.google.com/apikey");
        const customModel = await askQuestion("Model name (press Enter for default 'gemini-2.0-flash'): ");
        model = customModel.trim() || 'gemini-2.0-flash';
      } else if (choice === '3') {
        provider = 'openai';
        baseUrl = 'https://api.openai.com';
        console.log("\nGet your OpenAI key here: https://platform.openai.com/api-keys");
        const customModel = await askQuestion("Model name (press Enter for default 'gpt-4o'): ");
        model = customModel.trim() || 'gpt-4o';
      } else if (choice === '4') {
        provider = 'custom';
        model = await askQuestion("Model name (e.g., llama3): ");
        baseUrl = await askQuestion("Base URL (e.g., http://localhost:11434): ");
      } else {
        console.log("Invalid choice. Please select 1, 2, 3, or 4.");
        continue;
      }

      const apiKey = await askQuestion("Paste your API key (leave blank for local models): ");

      console.log("\n--- Configuration Summary ---");
      console.log(`Provider: ${provider}`);
      console.log(`Model:    ${model}`);
      console.log(`Base URL: ${baseUrl || 'N/A'}`);
      // Mask API key for security in display
      console.log(`API Key:  ${apiKey ? apiKey.substring(0, 4) + '*'.repeat(Math.max(0, apiKey.length - 4)) : 'None'}`);
      console.log("-----------------------------\n");

      const confirm = await askQuestion("Does this look correct? (y/n, default: y): ");
      if (confirm.toLowerCase() === 'y' || confirm.trim() === '') {
        config = {
          provider,
          apiKey,
          model,
          baseUrl
        };
        confirmed = true;
      } else {
        console.log("Let's restart the configuration setup.");
      }
    }

    rl.close();

    // Save finalized config to home directory
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    try {
      // Ensure config file is not readable by other users (POSIX only)
      if (process.platform !== 'win32') {
        fs.chmodSync(configPath, 0o600);
      }
    } catch (chmodErr) {
    }

    return config;
  } else {
    // Priority 3: Load from existing file
    const rawData = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(rawData);
  }
}

module.exports = { getConfig };