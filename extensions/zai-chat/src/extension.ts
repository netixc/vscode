/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

interface ZAIModel {
	id: string;
	name: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	supportsThinking?: boolean;
}

const ZAI_MODELS: ZAIModel[] = [
	{
		id: 'glm-4.6',
		name: 'GLM-4.6',
		maxInputTokens: 128000,
		maxOutputTokens: 128000,
		supportsThinking: true
	},
	{
		id: 'glm-4.5',
		name: 'GLM-4.5',
		maxInputTokens: 128000,
		maxOutputTokens: 128000,
		supportsThinking: true
	},
	{
		id: 'glm-4.5-Air',
		name: 'GLM-4.5 Air',
		maxInputTokens: 128000,
		maxOutputTokens: 128000,
		supportsThinking: true
	}
];

interface OpenAIMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

interface OpenAIRequest {
	model: string;
	messages: OpenAIMessage[];
	stream: boolean;
	temperature?: number;
	max_tokens?: number;
}

interface OpenAIStreamChunk {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: Array<{
		index: number;
		delta: {
			role?: string;
			content?: string;
			reasoning_content?: string;
		};
		finish_reason: string | null;
	}>;
}

class ZAILanguageModelProvider implements vscode.LanguageModelChatProvider {
	private config: vscode.WorkspaceConfiguration;

	constructor() {
		this.config = vscode.workspace.getConfiguration('zai');
	}

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		return ZAI_MODELS.map((model, index) => ({
			id: model.id,
			name: model.name,
			version: '1.0.0',
			family: 'glm',
			maxInputTokens: model.maxInputTokens,
			maxOutputTokens: model.maxOutputTokens,
			capabilities: {
				toolCalling: true,
				imageInput: false
			},
			isUserSelectable: true,
			isDefault: index === 0 // Make GLM-4.6 the default
		}));
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		_options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const apiKey = this.config.get<string>('apiKey');
		const baseUrl = this.config.get<string>('baseUrl', 'https://api.z.ai/api/coding/paas/v4/');
		const timeout = this.config.get<number>('timeout', 30000);

		if (!apiKey) {
			throw new Error('Z.AI API key not configured. Please set zai.apiKey in settings.');
		}

		// Convert VSCode messages to OpenAI format
		const openAIMessages: OpenAIMessage[] = messages.map(msg => ({
			role: msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' :
				  msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'system',
			content: msg.content.map((part: unknown) => {
				if (part instanceof vscode.LanguageModelTextPart) {
					return part.value;
				}
				return '';
			}).join('')
		}));

		const requestBody: OpenAIRequest = {
			model: model.id,
			messages: openAIMessages,
			stream: true,
			temperature: 0.6
		};

		try {
			const response = await this.fetchWithTimeout(
				`${baseUrl}chat/completions`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${apiKey}`
					},
					body: JSON.stringify(requestBody)
				},
				timeout,
				token
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Z.AI API error (${response.status}): ${errorText}`);
			}

			if (!response.body) {
				throw new Error('Response body is null');
			}

			await this.processStream(response.body, progress, token);
		} catch (error) {
			if (token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			throw error;
		}
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken
	): Promise<number> {
		// Rough token estimation (1 token ≈ 4 characters for English)
		const content = typeof text === 'string' ? text :
						text.content.map((part: unknown) => {
							if (part instanceof vscode.LanguageModelTextPart) {
								return part.value;
							}
							return '';
						}).join('');

		return Math.ceil(content.length / 4);
	}

	private async fetchWithTimeout(
		url: string,
		options: RequestInit,
		timeout: number,
		token: vscode.CancellationToken
	): Promise<Response> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeout);

		// Listen to cancellation token
		const cancellationListener = token.onCancellationRequested(() => {
			controller.abort();
		});

		try {
			const response = await fetch(url, {
				...options,
				signal: controller.signal
			});
			return response;
		} finally {
			clearTimeout(timeoutId);
			cancellationListener.dispose();
		}
	}

	private async processStream(
		body: ReadableStream<Uint8Array>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				if (token.isCancellationRequested) {
					reader.cancel();
					throw new vscode.CancellationError();
				}

				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (line.startsWith('data: ')) {
						const data = line.slice(6).trim();
						if (data === '[DONE]') {
							continue;
						}

						try {
							const chunk: OpenAIStreamChunk = JSON.parse(data);
							const delta = chunk.choices[0]?.delta;

							if (delta?.content) {
								progress.report(new vscode.LanguageModelTextPart(delta.content));
							}

							// Handle thinking/reasoning content if present
							if (delta?.reasoning_content) {
								progress.report(new vscode.LanguageModelTextPart(delta.reasoning_content));
							}
						} catch (parseError) {
							console.error('Error parsing SSE chunk:', parseError);
						}
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}
}

export function activate(context: vscode.ExtensionContext) {
	const provider = new ZAILanguageModelProvider();

	const disposable = vscode.lm.registerLanguageModelChatProvider('zai', provider);
	context.subscriptions.push(disposable);

	// Register chat participant
	const participant = vscode.chat.createChatParticipant('zai.chat', async (request, _context, response, token) => {
		// Simple pass-through participant that uses the language model
		const models = await vscode.lm.selectChatModels({ vendor: 'zai' });

		if (models.length === 0) {
			response.markdown('No Z.AI models available. Please check your API key configuration.');
			return {};
		}

		const model = models[0];
		const messages = [vscode.LanguageModelChatMessage.User(request.prompt)];

		try {
			const chatResponse = await model.sendRequest(messages, {}, token);

			for await (const fragment of chatResponse.text) {
				response.markdown(fragment);
			}

			return {};
		} catch (error) {
			response.markdown(`Error: ${error instanceof Error ? error.message : String(error)}`);
			return {};
		}
	});

	context.subscriptions.push(participant);

	// Register a command to set API key
	const setApiKeyCommand = vscode.commands.registerCommand('zai.setApiKey', async () => {
		const apiKey = await vscode.window.showInputBox({
			prompt: 'Enter your Z.AI API Key',
			password: true,
			placeHolder: 'Get your API key from https://z.ai/manage-apikey/apikey-list'
		});

		if (apiKey) {
			await vscode.workspace.getConfiguration('zai').update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage('Z.AI API key saved successfully!');
		}
	});

	context.subscriptions.push(setApiKeyCommand);
}

export function deactivate() { }
