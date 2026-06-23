const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const configPath = path.join(os.homedir(), '.devsplainrc');

/** Retrieves the configuration for the AI provider. If a configuration file exists and no forceWizard flag is provided, the existing configuration will be returned. Otherwise, the function will prompt the user to input their configuration details. [ds] */
async function getConfig(forceWizard = false) {
  if (process.env.DEVSPLAIN_API_KEY || process.env.DEVSPLAIN_PROVIDER) {
    const provider = process.env.DEVSPLAIN_PROVIDER || 'gemini';
    const model = process.env.DEVSPLAIN_MODEL || (provider === 'gemini' ? 'gemini-2.0-flash' : (provider === 'claude' ? 'claude-3-5-sonnet-20240620' : 'llama-3.3-70b-versatile'));
    const baseUrl = process.env.DEVSPLAIN_BASE_URL || (provider === 'gemini' ? null : (provider === 'claude' ? 'https://api.anthropic.com' : 'https://api.groq.com/openai'));
    return {
      provider,
      apiKey: process.env.DEVSPLAIN_API_KEY || '',
      model,
      baseUrl
    };
  }

  // Check if configuration file exists or if forceWizard flag is set [ds]
  if (!fs.existsSync(configPath) || forceWizard) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

    let config = null;
    let confirmed = false;

    // Continuously prompt user for configuration details until confirmation [ds]
    while (!confirmed) {
      let baseUrl = "";
      let model = "";
      let provider = "";

      // Display available AI provider options [ds]
      console.log("\nWhich AI Provider Do You want to use?");
      console.log("1. Groq (Free, Fast, Llama-3)");
      console.log("2. Gemini (Free Tier)");
      console.log("3. OpenAI (Paid)");
      console.log("4. Custom (Ollama, local, etc)");
      console.log("5. Claude (Anthropic)");

      // Get user's selected AI provider option [ds]
      const choice = await askQuestion("Select (1-5): ");

      // Handle selected AI provider option [ds]
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
      } else if (choice === '5') {
        provider = 'claude';
        baseUrl = 'https://api.anthropic.com';
        console.log("\nGet your Anthropic key here: https://console.anthropic.com/settings/keys");
        const customModel = await askQuestion("Model name (press Enter for default 'claude-3-5-sonnet-20240620'): ");
        model = customModel.trim() || 'claude-3-5-sonnet-20240620';
      } else {
        console.log("Invalid choice. Please select 1, 2, 3, 4, or 5.");
        continue;
      }

      // Get API key from user [ds]
      const apiKey = await askQuestion("Paste your API key (leave blank for local models): ");

      // Display configuration summary [ds]
      console.log("\n--- Configuration Summary ---");
      console.log(`Provider: ${provider}`);
      console.log(`Model:    ${model}`);
      console.log(`Base URL: ${baseUrl || 'N/A'}`);
      console.log(`API Key:  ${apiKey ? apiKey.substring(0, 4) + '*'.repeat(Math.max(0, apiKey.length - 4)) : 'None'}`);
      console.log("-----------------------------\n");

      // Confirm configuration with user [ds]
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

    // Write configuration to file [ds]
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    try {
      // Set file permissions to prevent unauthorized access [ds]
      if (process.platform !== 'win32') {
        fs.chmodSync(configPath, 0o600);
      }
    } catch (chmodErr) {
    }

    return config;
  } else {
    // Read existing configuration from file [ds]
    const rawData = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(rawData);
  }
}

// Export the getConfig function [ds]
module.exports = { getConfig };