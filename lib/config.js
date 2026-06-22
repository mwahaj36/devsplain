// Import file system module for reading/writing config files
const fs = require('fs');
// Import path module for cross-platform file path manipulation
const path = require('path');
// Import os module to retrieve user home directory
const os = require('os');
// Import readline module for interactive command line input
const readline = require('readline');
// Resolve absolute path for the hidden configuration file in the user's home directory
const configPath = path.join(os.homedir(), '.devsplainrc');

/**
 * Retrieves the application configuration.
 * Checks environment variables first, then looks for a config file,
 * and triggers an interactive wizard if necessary.
 * @param {boolean} [forceWizard=false] - If true, forces the setup wizard regardless of existing config.
 * @returns {Promise<Object>} The configuration object containing provider, apiKey, model, and baseUrl.
*/
async function getConfig(forceWizard = false) {
  // Check if mandatory configuration is provided via environment variables
  if (process.env.DEVSPLAIN_API_KEY || process.env.DEVSPLAIN_PROVIDER) {
    // Fallback to 'gemini' if DEVSPLAIN_PROVIDER is not set
    const provider = process.env.DEVSPLAIN_PROVIDER || 'gemini';
    // Determine model: use env var if present; otherwise, use provider-specific defaults
    const model = process.env.DEVSPLAIN_MODEL || (provider === 'gemini' ? 'gemini-2.0-flash' : 'llama-3.3-70b-versatile');
    // Determine base URL: use env var if present; otherwise, set based on provider default
    const baseUrl = process.env.DEVSPLAIN_BASE_URL || (provider === 'gemini' ? null : 'https://api.groq.com/openai');
    // Return object constructed from environment variables
    return {
      provider,
      apiKey: process.env.DEVSPLAIN_API_KEY || '',
      model,
      baseUrl
    };
  }

  // Check if config file is missing OR if the forceWizard flag is triggered
  if (!fs.existsSync(configPath) || forceWizard) {
    // Initialize readline interface to capture user input
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    // Helper function wrapping readline into a Promise to allow async/await flow
    const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

    // Initialize local config object placeholder
    let config = null;
    // Initialize loop control flag
    let confirmed = false;

    // Start a loop that continues until the user confirms the displayed configuration
    while (!confirmed) {
      // Reset local state variables for every loop iteration
      let baseUrl = "";
      let model = "";
      let provider = "";

      // Output menu options to the console
      console.log("\nWhich AI Provider Do You want to use?");
      console.log("1. Groq (Free, Fast, Llama-3)");
      console.log("2. Gemini (Free Tier)");
      console.log("3. OpenAI (Paid)");
      console.log("4. Custom (Ollama, local, etc)");

      // Wait for user input selecting an AI provider
      const choice = await askQuestion("Select (1-4): ");

      // Handle Groq provider selection
      if (choice === '1') {
        provider = 'groq';
        baseUrl = 'https://api.groq.com/openai';
        console.log("\nGet your free Groq key here: https://console.groq.com/keys");
        // Prompt user for model name, defaulting to a specific Llama version
        const customModel = await askQuestion("Model name (press Enter for default 'llama-3.3-70b-versatile'): ");
        model = customModel.trim() || 'llama-3.3-70b-versatile';
      // Handle Gemini provider selection
      } else if (choice === '2') {
        provider = 'gemini';
        baseUrl = null;
        console.log("\nGet your free Gemini key here: https://aistudio.google.com/apikey");
        // Prompt user for model name, defaulting to a specific Gemini version
        const customModel = await askQuestion("Model name (press Enter for default 'gemini-2.0-flash'): ");
        model = customModel.trim() || 'gemini-2.0-flash';
      // Handle OpenAI provider selection
      } else if (choice === '3') {
        provider = 'openai';
        baseUrl = 'https://api.openai.com';
        console.log("\nGet your OpenAI key here: https://platform.openai.com/api-keys");
        // Prompt user for model name, defaulting to gpt-4o
        const customModel = await askQuestion("Model name (press Enter for default 'gpt-4o'): ");
        model = customModel.trim() || 'gpt-4o';
      // Handle Custom (local/private) provider
      } else if (choice === '4') {
        provider = 'custom';
        // Input model name for custom provider
        model = await askQuestion("Model name (e.g., llama3): ");
        // Input Base URL for custom provider
        baseUrl = await askQuestion("Base URL (e.g., http://localhost:11434): ");
      // Handle invalid input by printing error and restarting the loop
      } else {
        console.log("Invalid choice. Please select 1, 2, 3, or 4.");
        continue;
      }

      // Request API key; note that some providers/local setups may not require it
      const apiKey = await askQuestion("Paste your API key (leave blank for local models): ");

      // Display a summary block to verify user selections
      console.log("\n--- Configuration Summary ---");
      console.log(`Provider: ${provider}`);
      console.log(`Model:    ${model}`);
      console.log(`Base URL: ${baseUrl || 'N/A'}`);
      // Mask the API key in the console for security purposes
      console.log(`API Key:  ${apiKey ? apiKey.substring(0, 4) + '*'.repeat(Math.max(0, apiKey.length - 4)) : 'None'}`);
      console.log("-----------------------------\n");

      // Ask user if they wish to proceed with the provided details
      const confirm = await askQuestion("Does this look correct? (y/n, default: y): ");
      // Check if user confirms by typing 'y' or pressing enter
      if (confirm.toLowerCase() === 'y' || confirm.trim() === '') {
        // Store the final configuration settings
        config = {
          provider,
          apiKey,
          model,
          baseUrl
        };
        // Break the loop by setting the confirmation flag
        confirmed = true;
      } else {
        // If not confirmed, provide feedback and restart the loop
        console.log("Let's restart the configuration setup.");
      }
    }

    // Close the CLI input interface
    rl.close();

    // Write the final JSON config to the hidden file
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    // Attempt to restrict file permissions for security on non-Windows platforms
    try {
      // Ensure not running on Windows before attempting Unix chmod
      if (process.platform !== 'win32') {
        // Set permissions to read/write for the current user only
        fs.chmodSync(configPath, 0o600);
      }
    // Silently ignore errors in setting file permissions
    } catch (chmodErr) {
    }

    // Return the successfully saved configuration
    return config;
  // If no environment vars and config file exists, read existing file
  } else {
    // Read and parse the existing local config file
    const rawData = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(rawData);
  }
}

// Export the function for usage in other modules
module.exports = { getConfig };