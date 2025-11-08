# Z.AI Language Model Provider

This extension provides Z.AI language model integration for VS Code's Chat feature.

## Features

- Provides Z.AI GLM models (GLM-4.6, GLM-4.5, GLM-4.5 Air)
- OpenAI-compatible API integration
- Supports streaming responses
- Configurable via VS Code settings

## Configuration

Set your Z.AI API key in settings:

```json
{
  "zai.apiKey": "your-api-key-here",
  "zai.baseUrl": "https://api.z.ai/api/coding/paas/v4/",
  "zai.defaultModel": "glm-4.6"
}
```

Or use the command palette: `Z.AI: Set API Key`

## Get API Key

Get your API key from: https://z.ai/manage-apikey/apikey-list
