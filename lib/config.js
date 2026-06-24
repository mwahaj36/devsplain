const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const configPath = path.join(os.homedir(), '.devsplainrc');

/** Prompts the user for a secret input, hiding the input from the console [ds] */
function askSecret(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    process.stdout.write(query);
    process.stdin.setRawMode(true);
    let key = '';
    const onData = (char) => {
      char = char.toString();
      if (char === '\n' || char === '\r') {
        process.stdin.setRawMode(false);
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        rl.close();
        resolve(key);
      } else if (char === '\u0003') { // Ctrl+C
        process.exit();
      } else {
        key += char;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
  });
}

/** Retrieves the configuration, either from environment variables or by prompting the user [ds] */
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

  // If the configuration file does not exist or forceWizard is true, prompt the user to configure [ds]
  if (!fs.existsSync(configPath) || forceWizard) {
    let rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    let askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

    let config = null;
    let confirmed = false;

    // Continuously prompt the user until the configuration is confirmed [ds]
    while (!confirmed) {
      let baseUrl = "";
      let model = "";
      let provider = "";

      // Display the list of available AI providers [ds]
      console.log("\nWhich AI Provider Do You want to use?");
      console.log("1. Groq (Free, Fast, Llama-3)");
      console.log("2. Gemini (Free Tier)");
      console.log("3. OpenAI (Paid)");
      console.log("4. Custom (Ollama, local, etc)");
      console.log("5. Claude (Anthropic)");

      const choice = await askQuestion("Select (1-5): ");

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
        while (true) {
          model = (await askQuestion("Model name (e.g., llama3): ")).trim();
          if (model) break;
          console.log("Model name cannot be empty.");
        }
        while (true) {
          baseUrl = (await askQuestion("Base URL (e.g., http://localhost:11434): ")).trim();
          if (baseUrl) break;
          console.log("Base URL cannot be empty.");
        }
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

      // Prompt the user for an API key [ds]
      let apiKey = '';
      while (true) {
        const promptMsg = provider === 'custom' 
          ? "Paste your API key (leave blank for local models): " 
          : "Paste your API key: ";

        if (process.stdin.isTTY) {
          rl.close();
          apiKey = await askSecret(promptMsg);

          rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
          });
          askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));
        } else {
          apiKey = await askQuestion(promptMsg);
        }

        apiKey = apiKey.trim();
        if (provider === 'custom' || apiKey) {
          break;
        }
        console.log(`API key is required for provider '${provider}'.`);
      }

      // Ask the user if they want to enable auto-pruning of existing comments [ds]
      let autoPrune = false;
      while (true) {
        const pruneAns = (await askQuestion("Do you want devsplain to aggressively prune (overwrite) existing human/AI comments? (y/n, default: n): ")).trim().toLowerCase();
        if (pruneAns === '' || pruneAns === 'n' || pruneAns === 'no') {
          autoPrune = false;
          break;
        } else if (pruneAns === 'y' || pruneAns === 'yes') {
          autoPrune = true;
          break;
        }
        console.log("Invalid choice. Please enter 'y' or 'n'.");
      }

      // Display a summary of the configuration [ds]
      console.log("\n--- Configuration Summary ---");
      console.log(`Provider:     ${provider}`);
      console.log(`Model:        ${model}`);
      console.log(`Base URL:     ${baseUrl || 'N/A'}`);
      console.log(`API Key:      ${apiKey ? apiKey.substring(0, 4) + '*'.repeat(Math.max(0, apiKey.length - 4)) : 'None'}`);
      console.log(`Auto-Prune:   ${autoPrune ? 'Yes' : 'No'}`);
      console.log("-----------------------------\n");

      // Confirm the configuration with the user [ds]
      while (true) {
        const confirm = (await askQuestion("Does this look correct? (y/n, default: y): ")).trim().toLowerCase();
        if (confirm === '' || confirm === 'y' || confirm === 'yes') {
          config = {
            provider,
            apiKey,
            model,
            baseUrl,
            autoPrune
          };
          confirmed = true;
          break;
        } else if (confirm === 'n' || confirm === 'no') {
          break;
        }
        console.log("Invalid choice. Please enter 'y' or 'n'.");
      }
    }

    rl.close();

    // Write the configuration to the config file [ds]
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    try {
      // Set the permissions of the config file to prevent other users from reading it [ds]
      if (process.platform !== 'win32') {
        fs.chmodSync(configPath, 0o600);
      }
    } catch (chmodErr) {
    }

    return config;
  } else {
    const rawData = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(rawData);
  }
}

module.exports = { getConfig };
