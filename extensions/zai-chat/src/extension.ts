/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/// <reference path="../../../src/vscode-dts/vscode.proposed.chatSessionsProvider.d.ts" />

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
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_calls?: Array<{
		id: string;
		type: 'function';
		function: {
			name: string;
			arguments: string;
		};
	}>;
	tool_call_id?: string; // For role: "tool" messages
}

interface OpenAITool {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: object;
	};
}

interface OpenAIRequest {
	model: string;
	messages: OpenAIMessage[];
	stream: boolean;
	temperature?: number;
	max_tokens?: number;
	tools?: OpenAITool[];
	tool_choice?: 'auto' | 'none' | 'required';
	extra_body?: {
		thinking?: {
			type: 'enabled' | 'disabled';
		};
	};
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
			tool_calls?: Array<{
				index?: number;
				id?: string;
				type?: 'function';
				function?: {
					name?: string;
					arguments?: string;
				};
			}>;
		};
		finish_reason: string | null;
	}>;
}

class ZAILanguageModelProvider implements vscode.LanguageModelChatProvider {
	private thinkingEnabled: boolean = false;

	constructor() {
		// No need to cache config - get fresh each time
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
		console.log('[Z.AI] provideLanguageModelChatResponse called');
		// Get fresh config each time to pick up setting changes
		const config = vscode.workspace.getConfiguration('zai');
		const apiKey = config.get<string>('apiKey');
		const baseUrl = config.get<string>('baseUrl', 'https://api.z.ai/api/coding/paas/v4/');
		const timeout = config.get<number>('timeout', 30000);
		const thinkingEnabled = config.get<boolean>('thinking.enabled', false);
		this.thinkingEnabled = thinkingEnabled;

		console.log('[Z.AI] thinkingEnabled:', thinkingEnabled);

		if (!apiKey) {
			throw new Error('Z.AI API key not configured. Please set zai.apiKey in settings.');
		}

		// Convert VSCode messages to OpenAI format
		// Note: Tool results need to become separate messages with role: "tool"
		const openAIMessages: OpenAIMessage[] = [];

		for (const msg of messages) {
			const role = msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' :
				msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'system';

			// Handle different content types
			const toolCallParts: any[] = [];
			const toolResultParts: Array<{ callId: string; content: string }> = [];
			let textContent = '';

			// Helper to check if part is a tool call
			function isToolCallPart(p: unknown): p is { callId: string; name: string; input: object } {
				if (typeof p !== 'object' || p === null) {
					return false;
				}
				const candidate = p as Record<string, unknown>;
				return typeof candidate.callId === 'string' &&
					typeof candidate.name === 'string' &&
					typeof candidate.input === 'object' &&
					candidate.input !== null;
			}

			// Helper to check if part is a tool result
			function isToolResultPart(p: unknown): p is { callId: string; content: unknown[] } {
				if (typeof p !== 'object' || p === null) {
					return false;
				}
				const candidate = p as Record<string, unknown>;
				return typeof candidate.callId === 'string' &&
					Array.isArray(candidate.content);
			}

			for (const part of msg.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textContent += part.value;
				} else if (isToolCallPart(part)) {
					// Tool call part
					toolCallParts.push({
						id: part.callId,
						type: 'function',
						function: {
							name: part.name,
							arguments: JSON.stringify(part.input)
						}
					});
				} else if (isToolResultPart(part)) {
					// Tool result part
					const resultText = part.content
						.filter(c => c instanceof vscode.LanguageModelTextPart)
						.map(c => (c as vscode.LanguageModelTextPart).value)
						.join('');
					toolResultParts.push({
						callId: part.callId,
						content: resultText
					});
				}
			}

			// Add the main message if it has tool calls or text content
			if (toolCallParts.length > 0) {
				openAIMessages.push({
					role: 'assistant',
					content: textContent || null,
					tool_calls: toolCallParts
				});
			} else if (toolResultParts.length === 0 && textContent) {
				// Regular text message (no tool results)
				openAIMessages.push({
					role: role,
					content: textContent
				});
			}

			// Add tool result messages (each becomes a separate message with role: "tool")
			for (const toolResult of toolResultParts) {
				openAIMessages.push({
					role: 'tool',
					tool_call_id: toolResult.callId,
					content: toolResult.content
				});
			}
		}

		// Convert tools if provided in options
		const tools: OpenAITool[] | undefined = _options.tools?.map(tool => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.inputSchema ?? {}
			}
		}));

		const requestBody: OpenAIRequest = {
			model: model.id,
			messages: openAIMessages,
			stream: true,
			temperature: 0.6,
			tools: tools,
			tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
			extra_body: {
				thinking: {
					type: thinkingEnabled ? 'enabled' : 'disabled'
				}
			}
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
		// Rough token estimation (1 token ~ 4 characters for English)
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

		// Accumulate tool calls across chunks
		const toolCallsMap = new Map<number, { id?: string; name?: string; arguments: string }>();

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
							// Stream is done, tool calls will be reported after the loop
							continue;
						}

						try {
							const chunk: OpenAIStreamChunk = JSON.parse(data);
							const delta = chunk.choices[0]?.delta;

							if (delta?.content) {
								progress.report(new vscode.LanguageModelTextPart(delta.content));
							}

							// Handle thinking/reasoning content only if thinking mode is enabled
							if (delta?.reasoning_content && this.thinkingEnabled) {
								progress.report(new vscode.LanguageModelTextPart(delta.reasoning_content));
							}

							// Handle tool calls - they come in chunks
							if (delta?.tool_calls) {
								for (const toolCallDelta of delta.tool_calls) {
									const index = toolCallDelta.index ?? 0;
									if (!toolCallsMap.has(index)) {
										toolCallsMap.set(index, { arguments: '' });
									}
									const toolCall = toolCallsMap.get(index)!;

									if (toolCallDelta.id) {
										toolCall.id = toolCallDelta.id;
									}
									if (toolCallDelta.function?.name) {
										toolCall.name = toolCallDelta.function.name;
									}
									if (toolCallDelta.function?.arguments) {
										toolCall.arguments += toolCallDelta.function.arguments;
									}
								}
							}
						} catch (parseError) {
							console.error('Error parsing SSE chunk:', parseError);
						}
					}
				}
			}

			// Report any remaining tool calls
			for (const [_, toolCall] of toolCallsMap) {
				if (toolCall.id && toolCall.name && toolCall.arguments) {
					try {
						const args = JSON.parse(toolCall.arguments);
						progress.report(new vscode.LanguageModelToolCallPart(
							toolCall.id,
							toolCall.name,
							args
						));
					} catch (e) {
						console.error('Error parsing tool call arguments:', e);
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}
}

// Session item provider that tracks and lists Z.AI sessions
class ZAISessionItemProvider implements vscode.ChatSessionItemProvider {
	private readonly _onDidChangeChatSessionItems = new vscode.EventEmitter<void>();
	readonly onDidChangeChatSessionItems = this._onDidChangeChatSessionItems.event;

	private readonly _onDidCommitChatSessionItem = new vscode.EventEmitter<{
		original: vscode.ChatSessionItem;
		modified: vscode.ChatSessionItem;
	}>();
	readonly onDidCommitChatSessionItem = this._onDidCommitChatSessionItem.event;

	private sessions = new Map<string, vscode.ChatSessionItem>();

	constructor() {
		// No automatic tracking needed - sessions are registered explicitly
	}

	// Called by content provider when a session is created
	registerSession(uri: vscode.Uri, label?: string): void {
		const key = uri.toString();
		if (!this.sessions.has(key)) {
			console.log('[Z.AI] Registering new session:', key);
			this.sessions.set(key, {
				resource: uri,
				label: label || 'Z.AI Session',
				iconPath: new vscode.ThemeIcon('sparkle'),
				status: vscode.ChatSessionStatus.InProgress,
				timing: {
					startTime: Date.now()
				}
			});
			this._onDidChangeChatSessionItems.fire();
		}
	}

	// Update session status
	updateSessionStatus(uri: vscode.Uri, status: vscode.ChatSessionStatus): void {
		const key = uri.toString();
		const session = this.sessions.get(key);
		if (session) {
			console.log('[Z.AI] Updating session status:', key, 'to', vscode.ChatSessionStatus[status]);
			session.status = status;
			if (status === vscode.ChatSessionStatus.Completed || status === vscode.ChatSessionStatus.Failed) {
				if (session.timing) {
					session.timing.endTime = Date.now();
				}
			}
			this._onDidChangeChatSessionItems.fire();
		}
	}

	// Called when a session is closed
	unregisterSession(uri: vscode.Uri): void {
		const key = uri.toString();
		if (this.sessions.has(key)) {
			console.log('[Z.AI] Unregistering session:', key);
			this.sessions.delete(key);
			this._onDidChangeChatSessionItems.fire();
		}
	}

	async provideChatSessionItems(_token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> {
		console.log('[Z.AI] provideChatSessionItems called, returning', this.sessions.size, 'sessions');
		return Array.from(this.sessions.values());
	}
}

export function activate(context: vscode.ExtensionContext) {
	const provider = new ZAILanguageModelProvider();

	const disposable = vscode.lm.registerLanguageModelChatProvider('zai', provider);
	context.subscriptions.push(disposable);

	// Register the session item provider (tracks list of sessions)
	const sessionItemProvider = new ZAISessionItemProvider();

	// Register chat session content provider for zai-session:// URIs
	// The chatSessions contribution automatically creates the agent and command
	const sessionProvider: vscode.ChatSessionContentProvider = {
		provideChatSessionContent: async (resource: vscode.Uri, _token: vscode.CancellationToken): Promise<vscode.ChatSession> => {
			console.log('[Z.AI] provideChatSessionContent called for:', resource.toString());
			// Register this session with the item provider
			sessionItemProvider.registerSession(resource);
			// Return a session with a request handler
			return {
				history: [],
				requestHandler: handleChatRequest
			};
		}
	};

	// Shared chat request handler for all sessions
	async function handleChatRequest(request: vscode.ChatRequest, context: vscode.ChatContext, response: vscode.ChatResponseStream, token: vscode.CancellationToken) {
		console.log('[Z.AI] handleChatRequest called with prompt:', request.prompt);

		// Get session URI from context to track status
		const sessionUri = context.chatSessionContext?.chatSessionItem.resource;

		// Mark session as in progress
		if (sessionUri) {
			sessionItemProvider.updateSessionStatus(sessionUri, vscode.ChatSessionStatus.InProgress);
		}

		const models = await vscode.lm.selectChatModels({ vendor: 'zai' });
		console.log('[Z.AI] Found models:', models.length);

		if (models.length === 0) {
			response.markdown('No Z.AI models available. Please check your API key configuration.');
			if (sessionUri) {
				sessionItemProvider.updateSessionStatus(sessionUri, vscode.ChatSessionStatus.Failed);
			}
			return;
		}

		const model = models[0];
		const messages: vscode.LanguageModelChatMessage[] = [
			vscode.LanguageModelChatMessage.User(request.prompt)
		];

		// Get all available tools from VS Code
		const availableTools = vscode.lm.tools.map(tool => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema ?? {}
		}));

		// Tool calling loop - continue until the model stops requesting tools
		try {
			let turnCount = 0;
			while (!token.isCancellationRequested) {
				turnCount++;
				console.log(`[Z.AI Chat] Tool calling turn ${turnCount}`);

				const chatResponse = await model.sendRequest(messages, {
					tools: availableTools,
					toolMode: vscode.LanguageModelChatToolMode.Auto
				}, token);

				let hasToolCalls = false;
				const toolCalls: vscode.LanguageModelToolCallPart[] = [];
				let assistantContent = '';

				// Process the response stream
				for await (const part of chatResponse.stream) {
					if (part instanceof vscode.LanguageModelTextPart) {
						assistantContent += part.value;
						response.markdown(part.value);
					} else if (part instanceof vscode.LanguageModelToolCallPart) {
						hasToolCalls = true;
						toolCalls.push(part);
						console.log(`[Z.AI Chat] Tool call requested: ${part.name} with input:`, part.input);
						// Show tool invocation in the UI
						response.progress(`Calling tool: ${part.name}`);
					}
				}

				// If no tool calls, we're done
				if (!hasToolCalls) {
					console.log(`[Z.AI Chat] No more tool calls, finishing after ${turnCount} turns`);
					break;
				}

				// Add assistant's response with tool calls to conversation history
				messages.push(vscode.LanguageModelChatMessage.Assistant(toolCalls));

				// Execute tool calls and collect results
				const toolResults: vscode.LanguageModelToolResultPart[] = [];
				for (const toolCall of toolCalls) {
					try {
						const result = await vscode.lm.invokeTool(toolCall.name, {
							input: toolCall.input,
							toolInvocationToken: request.toolInvocationToken
						}, token);

						toolResults.push(new vscode.LanguageModelToolResultPart(toolCall.callId, result.content));
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						toolResults.push(new vscode.LanguageModelToolResultPart(
							toolCall.callId,
							[new vscode.LanguageModelTextPart(`Error: ${errorMessage}`)]
						));
					}
				}

				// Add tool results to conversation as a user message
				messages.push(vscode.LanguageModelChatMessage.User(toolResults));
			}

			// Mark session as completed
			if (sessionUri) {
				sessionItemProvider.updateSessionStatus(sessionUri, vscode.ChatSessionStatus.Completed);
			}

		} catch (error) {
			console.error('[Z.AI] Error in handleChatRequest:', error);
			response.markdown(`Error: ${error instanceof Error ? error.message : String(error)}`);

			// Mark session as failed
			if (sessionUri) {
				sessionItemProvider.updateSessionStatus(sessionUri, vscode.ChatSessionStatus.Failed);
			}
		}
	}

	console.log('[Z.AI] Extension activated');

	// Create the chat participant that matches our chatParticipants and chatSessions declarations
	const participant = vscode.chat.createChatParticipant('zai-session', async (request, context, response, token) => {
		console.log('[Z.AI] Participant handler called (should use session provider instead)');
		// Delegate to the shared handler
		await handleChatRequest(request, context, response, token);
		return {};
	});
	context.subscriptions.push(participant);

	// Register the session item provider (created earlier)
	console.log('[Z.AI] Registering session item provider');
	const sessionItemDisposable = vscode.chat.registerChatSessionItemProvider('zai-session', sessionItemProvider);
	context.subscriptions.push(sessionItemDisposable);
	console.log('[Z.AI] Session item provider registered');

	// Register the session content provider (provides content for each session)
	console.log('[Z.AI] Registering session content provider');
	const sessionDisposable = vscode.chat.registerChatSessionContentProvider('zai-session', sessionProvider, participant);
	context.subscriptions.push(sessionDisposable);
	console.log('[Z.AI] Session content provider registered');

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
