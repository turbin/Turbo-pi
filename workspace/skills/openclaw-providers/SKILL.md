---
name: openclaw-provider-config
description: Reusable skill for adding or updating LLM providers in OpenClaw model configuration
---

# OpenClaw Provider Configuration Skill

This skill provides step-by-step instructions for adding new LLM model providers to OpenClaw configuration. OpenClaw uses a JSON-based configuration file (`.openclaw/openclaw.json`) to define model providers, their models, and agent defaults.

## Overview

OpenClaw provider configuration consists of three main components:
1. **Provider Definition**: Basic provider settings (baseUrl, api type, apiKey)
2. **Model Entries**: Model-specific configurations under each provider
3. **Agent Defaults**: Default model settings for agents using this configuration

## File Location

Edit or create the configuration file at: `.openclaw/openclaw.json`

---

## Step 1: Add Provider Definition

Add a new provider to the `providers` section in your config:

```json
"providers": {
  "<provider-name>": {
    "baseUrl": "https://api.provider.com/v1",
    "api": "openai-completions",
    "apiKey": "YOUR_API_KEY",
    "models": {
      "<model-name-1>": {
        "contextWindow": <number>,
        "maxTokens": <number>,
        "reasoning": "<string or boolean>"
      },
      "<model-name-2>": {
        "contextWindow": <number>,
        "maxTokens": <number>,
        "reasoning": "<string or boolean>"
      }
    }
  }
}
```

**Provider Fields:**
- `baseUrl` (required): The API endpoint URL for the provider
- `api` (required): API type - typically `"openai-completions"` or `"anthropic-messages"`
- `apiKey` (required): Your API key for authentication
- `timeoutMs` (optional): Request timeout in milliseconds
- `maxRetries` (optional): Maximum retry attempts for failed requests

---

## Step 2: Define Model Entries

Each model should be defined with the following fields:

```json
"models": {
  "<model-name>": {
    "contextWindow": <number>,
    "maxTokens": <number>,
    "reasoning": "<string or boolean>"
  }
}
```

**Model Fields:**
- `contextWindow` (recommended): Maximum input tokens the model can handle
  - Typical values: 128000, 200000, 256000
- `maxTokens` (required): Maximum tokens in the response
  - Typical values: 4096, 8192, 32768, 65536
- `reasoning` (optional): Reasoning capability specification
  - String format: `"enabled"`, `"enabled-medium"`, `"enabled-high"`
  - Boolean: `true` or `false`

---

## Step 3: Configure Agent Defaults

Set default models for agents to use:

```json
"agents": {
  "defaults": {
    "model": {
      "primary": "<provider-name>/<model-name>"
    },
    "models": [
      "<provider-name>/<model-name-1>",
      "<provider-name>/<model-name-2>",
      ...
    ]
  }
}
```

**Agent Default Fields:**
- `model.primary`: The default model format as `"<provider>/<model-name>"`
- `models`: Array of all available models from configured providers

---

## Complete Example Structure

```json
{
  "gateway": {
    "bind": "0.0.0.0:3000"
  },
  "models": {
    "providers": {
      "bailian": {
        "baseUrl": "https://coding.dashscope.aliyuncs.com/v1",
        "api": "openai-completions",
        "apiKey": "YOUR_BAILIAN_API_KEY",
        "models": {
          "qwen3-max-2026-01-23": {
            "contextWindow": 256000,
            "maxTokens": 65536,
            "reasoning": "enabled-high"
          },
          "qwen3.5-plus": {
            "contextWindow": 256000,
            "maxTokens": 4096,
            "reasoning": "enabled-medium"
          }
        }
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "bailian/qwen3.5-plus"
      },
      "models": [
        "bailian/qwen3-max-2026-01-23",
        "bailian/qwen3.5-plus",
        "bailian/qwen3-coder-next",
        "bailian/qwen3-coder-plus",
        "bailian/glm-4.7",
        "bailian/kimi-k2.5"
      ]
    }
  }
}
```

---

## Quick Reference for Common Providers

### OpenAI
```json
{
  "baseUrl": "https://api.openai.com/v1",
  "api": "openai-completions",
  "apiKey": "sk-xxx"
}
```

### Anthropic
```json
{
  "baseUrl": "https://api.anthropic.com/v1",
  "api": "anthropic-messages",
  "apiKey": "sk-xxx"
}
```

### OpenRouter
```json
{
  "baseUrl": "https://openrouter.ai/api/v1",
  "api": "openai-completions",
  "apiKey": "Bearer sk-xxx"
}
```

---

## Tips

1. **Always set a fallback**: Configure at least one primary and one fallback model
2. **Test before deploying**: Validate your JSON syntax before using in production
3. **Secure your keys**: Never commit actual API keys; use environment variables
4. **Set reasonable timeouts**: Match provider API limits (typically 60000-120000ms)
5. **Model selection**: Choose primary model based on use case (coding, general, etc.)

---

## How to Verify Your Config

After editing `.openclaw/openclaw.json`, verify the configuration:

```bash
# Check JSON syntax validity
python -m json.tool .openclaw/openclaw.json
# or
jq . .openclaw/openclaw.json
```

**To confirm OpenClaw picks up the config:**
1. Restart the OpenClaw server
2. Check the gateway logs: `cat /var/log/openclaw/gateway.log`
3. Look for model loading messages or "providers loaded" entries
4. Send a test request through OpenClaw and check which model is selected in the response
5. Use `jq` to inspect the running config if OpenClaw exposes config via API
