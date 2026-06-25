const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const configPath = path.join(os.homedir(), '.devsplainrc');

/** Asks the user for a secret input, such as an API key, without echoing the input to the console. [ds] */
function askSecret(query) {
  // Return a promise that resolves with the user's secret input [ds]
  return new Promise((resolve) => {
    // Create a readline interface to handle user input [ds]
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    // Write the query to the console, prompting the user for input [ds]
    process.stdout.write(query);
    // Enable raw mode on stdin to capture individual key presses [ds]
    process.stdin.setRawMode(true);
    let key = '';
    // Define a callback function to handle incoming data from stdin [ds]
    const onData = (char) => {
      // Convert the character to a string [ds]
      char = char.toString();
      // Check if the user has pressed Enter or Return [ds]
      if (char === '\n' || char === '\r') {
        // Disable raw mode on stdin [ds]
        process.stdin.setRawMode(false);
        // Remove the data listener from stdin [ds]
        process.stdin.removeListener('data', onData);
        // Write a newline character to the console [ds]
        process.stdout.write('\n');
        // Close the readline interface [ds]
        rl.close();
        // Resolve the promise with the user's secret input [ds]
        resolve(key);
      // Check if the user has pressed Ctrl+C [ds]
      } else if (char === '\u0003') { // Ctrl+C
        // Exit the process if Ctrl+C is pressed [ds]
        process.exit();
      } else {
        // Append the character to the secret input string [ds]
        key += char;
        // Write an asterisk to the console to mask the user's input [ds]
        process.stdout.write('*');
      }
    };
    // Add the data listener to stdin [ds]
    process.stdin.on('data', onData);
  });
}

/** Retrieves the configuration settings, either from environment variables or by prompting the user. [ds] */
async function getConfig(forceWizard = false) {
  // Check if the API key and provider are set in environment variables [ds]
  if (process.env.DEVSPLAIN_API_KEY || process.env.DEVSPLAIN_PROVIDER) {
    // Determine the provider from the environment variable or default to 'gemini' [ds]
    const provider = process.env.DEVSPLAIN_PROVIDER || 'gemini';
    // Determine the model from the environment variable or default based on the provider [ds]
    const model = process.env.DEVSPLAIN_MODEL || (provider === 'gemini' ? 'gemini-2.0-flash' : (provider === 'claude' ? 'claude-3-5-sonnet-20240620' : 'llama-3.3-70b-versatile'));
    // Determine the base URL from the environment variable or default based on the provider [ds]
    const baseUrl = process.env.DEVSPLAIN_BASE_URL || (provider === 'gemini' ? null : (provider === 'claude' ? 'https://api.anthropic.com' : 'https://api.groq.com/openai'));
    // Return the configuration settings as an object [ds]
    return {
      provider,
      apiKey: process.env.DEVSPLAIN_API_KEY || '',
      model,
      baseUrl
    };
  }

  // Check if the configuration file does not exist or if the wizard should be forced [ds]
  if (!fs.existsSync(configPath) || forceWizard) {
    // Create a readline interface to handle user input [ds]
    let rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    // Define a function to ask the user a question and return a promise with the response [ds]
    let askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

    let config = null;
    let confirmed = false;

    // Loop until the user confirms their configuration settings [ds]
    while (!confirmed) {
      let baseUrl = "";
      let model = "";
      let provider = "";

      // Display a menu to the user to select their AI provider [ds]
      console.log("\nWhich AI Provider Do You want to use?");
      console.log("1. Groq (Free, Fast, Llama-3)");
      console.log("2. Gemini (Free Tier)");
      console.log("3. OpenAI (Paid)");
      console.log("4. Custom (Ollama, local, etc)");
      console.log("5. Claude (Anthropic)");

      // Ask the user to select a provider [ds]
      const choice = await askQuestion("Select (1-5): ");

      // Check if the user selected Groq as their provider [ds]
      if (choice === '1') {
        // Set the provider to 'groq' [ds]
        provider = 'groq';
        // Set the base URL to the Groq API [ds]
        baseUrl = 'https://api.groq.com/openai';
        // Display a message to the user with instructions on how to obtain a Groq key [ds]
        console.log("\nGet your free Groq key here: https://console.groq.com/keys");
        // Ask the user for their model name, defaulting to 'llama-3.3-70b-versatile' [ds]
        const customModel = await askQuestion("Model name (press Enter for default 'llama-3.3-70b-versatile'): ");
        model = customModel.trim() || 'llama-3.3-70b-versatile';
      // Set the model name based on the user's input [ds]
      } else if (choice === '2') {
        // Check if the user selected Gemini as their provider [ds]
        provider = 'gemini';
        // Set the provider to 'gemini' [ds]
        baseUrl = null;
        // Set the base URL to null [ds]
        console.log("\nGet your free Gemini key here: https://aistudio.google.com/apikey");
        // Display a message to the user with instructions on how to obtain a Gemini key [ds]
        const customModel = await askQuestion("Model name (press Enter for default 'gemini-2.0-flash'): ");
        // Ask the user for their model name, defaulting to 'gemini-2.0-flash' [ds]
        model = customModel.trim() || 'gemini-2.0-flash';
      } else if (choice === '3') {
        // Check if the user selected OpenAI as their provider [ds]
        provider = 'openai';
        // Set the provider to 'openai' [ds]
        baseUrl = 'https://api.openai.com';
        // Set the base URL to the OpenAI API [ds]
        console.log("\nGet your OpenAI key here: https://platform.openai.com/api-keys");
        // Display a message to the user with instructions on how to obtain an OpenAI key [ds]
        const customModel = await askQuestion("Model name (press Enter for default 'gpt-4o'): ");
        // Ask the user for their model name, defaulting to 'gpt-4o' [ds]
        model = customModel.trim() || 'gpt-4o';
      } else if (choice === '4') {
        // Check if the user selected a custom provider [ds]
        provider = 'custom';
        // Loop until the user enters a non-empty model name [ds]
        while (true) {
          // Ask the user for their model name [ds]
          model = (await askQuestion("Model name (e.g., llama3): ")).trim();
          // Check if the model name is empty [ds]
          if (model) break;
          // Display an error message if the model name is empty [ds]
          console.log("Model name cannot be empty.");
        }
        // Loop until the user enters a non-empty base URL [ds]
        while (true) {
          // Ask the user for their base URL [ds]
          baseUrl = (await askQuestion("Base URL (e.g., http://localhost:11434): ")).trim();
          // Check if the base URL is empty [ds]
          if (baseUrl) break;
          // Display an error message if the base URL is empty [ds]
          console.log("Base URL cannot be empty.");
        }
      // Check if the user selected Claude as their provider [ds]
      } else if (choice === '5') {
        // Set the provider to 'claude' [ds]
        provider = 'claude';
        // Set the base URL to the Anthropic API [ds]
        baseUrl = 'https://api.anthropic.com';
        // Display a message to the user with instructions on how to obtain a Claude key [ds]
        console.log("\nGet your Anthropic key here: https://console.anthropic.com/settings/keys");
        // Ask the user for their model name, defaulting to 'claude-3-5-sonnet-20240620' [ds]
        const customModel = await askQuestion("Model name (press Enter for default 'claude-3-5-sonnet-20240620'): ");
        model = customModel.trim() || 'claude-3-5-sonnet-20240620';
      // Set the model name based on the user's input [ds]
      } else {
        // Check if the user's selection is invalid [ds]
        console.log("Invalid choice. Please select 1, 2, 3, 4, or 5.");
        // Display an error message and continue to the next iteration [ds]
        continue;
      }

      // Initialize the API key to an empty string [ds]
      let apiKey = '';
      // Loop until the user enters a valid API key [ds]
      while (true) {
        // Determine the prompt message based on the provider [ds]
        const promptMsg = provider === 'custom' 
          ? "Paste your API key (leave blank for local models): " 
          : "Paste your API key: ";

        // Check if stdin is a TTY [ds]
        if (process.stdin.isTTY) {
          // Close the readline interface to prevent echoing the API key [ds]
          rl.close();
          // Ask the user for their API key using the askSecret function [ds]
          apiKey = await askSecret(promptMsg);

          // Re-create the readline interface [ds]
          rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
          });
          // Update the askQuestion function to use the new readline interface [ds]
          askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));
        } else {
          // Ask the user for their API key using the askQuestion function [ds]
          apiKey = await askQuestion(promptMsg);
        }
// Trim the API key to remove whitespace [ds]

        // Check if the provider is custom or if the API key is not empty [ds]
        apiKey = apiKey.trim();
        if (provider === 'custom' || apiKey) {
          // Break out of the loop if the API key is valid [ds]
          break;
        }
        // Display an error message if the API key is empty [ds]
        console.log(`API key is required for provider '${provider}'.`);
      }

      // Initialize the auto-prune setting to false [ds]
      let autoPrune = false;
      // Loop until the user enters a valid response [ds]
      while (true) {
        // Ask the user if they want to enable auto-prune [ds]
        const pruneAns = (await askQuestion("Do you want devsplain to aggressively prune (overwrite) existing human/AI comments? (y/n, default: n): ")).trim().toLowerCase();
        // Check if the user's response is empty or 'n' [ds]
        if (pruneAns === '' || pruneAns === 'n' || pruneAns === 'no') {
          // Set auto-prune to false [ds]
          autoPrune = false;
          // Break out of the loop [ds]
          break;
        // Check if the user's response is 'y' [ds]
        } else if (pruneAns === 'y' || pruneAns === 'yes') {
          // Set auto-prune to true [ds]
          autoPrune = true;
          // Break out of the loop [ds]
          break;
        }
        // Display an error message if the user's response is invalid [ds]
        console.log("Invalid choice. Please enter 'y' or 'n'.");
      }

      // Display a summary of the user's configuration settings [ds]
      console.log("\n--- Configuration Summary ---");
      console.log(`Provider:     ${provider}`);
      console.log(`Model:        ${model}`);
      console.log(`Base URL:     ${baseUrl || 'N/A'}`);
      console.log(`API Key:      ${apiKey ? apiKey.substring(0, 4) + '*'.repeat(Math.max(0, apiKey.length - 4)) : 'None'}`);
      console.log(`Auto-Prune:   ${autoPrune ? 'Yes' : 'No'}`);
      console.log("-----------------------------\n");

      // Loop until the user confirms their configuration settings [ds]
      while (true) {
        // Ask the user to confirm their configuration settings [ds]
        const confirm = (await askQuestion("Does this look correct? (y/n, default: y): ")).trim().toLowerCase();
        // Check if the user's response is empty or 'y' [ds]
        if (confirm === '' || confirm === 'y' || confirm === 'yes') {
          // Create a configuration object with the user's settings [ds]
          config = {
            // Set the confirmed flag to true [ds]
            provider,
            // Break out of the loop [ds]
            apiKey,
            model,
            baseUrl,
            autoPrune
          };
          // Set the configuration settings [ds]
          confirmed = true;
          // Set the confirmed flag to true [ds]
          break;
        // Break out of the loop [ds]
        } else if (confirm === 'n' || confirm === 'no') {
          // Break out of the loop if the user does not confirm [ds]
          break;
        }
        console.log("Invalid choice. Please enter 'y' or 'n'.");
      }
    }

    // Close the readline interface [ds]
    rl.close();

    // Write the configuration settings to the configuration file [ds]
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    try {
      // Check if the platform is not Windows [ds]
      if (process.platform !== 'win32') {
        // Set the permissions of the configuration file to 600 (read and write for the owner only) [ds]
        fs.chmodSync(configPath, 0o600);
      }
    } catch (chmodErr) {
    }

    // Return the configuration settings [ds]
    return config;
  } else {
    // Check if the configuration file exists [ds]
    const rawData = fs.readFileSync(configPath, 'utf8');
    // Read the configuration settings from the file and return them [ds]
    return JSON.parse(rawData);
  }
}

module.exports = { getConfig };
