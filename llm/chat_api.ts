import { ModelPreset } from './Interfaces';

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';

class APIError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'APIError';
    }
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface PromptParams {
  model: string;
  messages: Message[];
  stream_options?: {include_usage: boolean};
  temperature?: number;
  stream: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  provider?: any;
  reasoning_effort?: string;
}

interface LLMResponse {
    text: string;
    cost?: number;
    tokens_per_second?: number;
}

async function getCost({modelPreset, inputTokens, outputTokens}: {
    modelPreset: ModelPreset, 
    inputTokens: number, 
    outputTokens: number
  }): Promise<number> {
    const model = modelPreset.model;
    if(modelPreset.input_cpm && modelPreset.output_cpm) {
        const totalCost = (modelPreset.input_cpm * inputTokens / 1000000) + (modelPreset.output_cpm * outputTokens / 1000000);
        return totalCost;
    } else {
        return 0
    }
  }

export interface PromptLLMReturn {
    onDelta: (callback: (delta: string) => void) => void;
    stopHandler: () => void;
    response: () => Promise<LLMResponse>;
    onError: (callback: (delta: string) => void) => void;
}

async function promptLLM({modelPreset, prompt, messages, images}: {
  modelPreset: ModelPreset | null, 
  prompt?: string, 
  messages?: Message[],
  images?: string[]
}): Promise<PromptLLMReturn> {
    if (!modelPreset) {
        throw new Error('Model preset is null');
    }
    if (!prompt && !messages) {
        throw new Error('Either prompt or messages must be provided');
    }

    console.log("Prompting LLM with model:", modelPreset.model);

    const messageList = messages || [{ role: 'user', content: prompt! }];

    const messageAndImageList = messageList.map(msg => {
        if (modelPreset?.provider.includes('Anthropic')) {
            const content: any[] = [];
            if (msg.content) {
                content.push({ type: 'text', text: msg.content });
            }
            if (images && images.length > 0 && msg.role === 'user') {
                images.forEach(imageBase64 => {
                    content.push({
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: imageBase64.split(',')[0].split(':')[1].split(';')[0],
                            data: imageBase64.split(',')[1]
                        }
                    });
                });
            }
            return {
                role: msg.role,
                content: content
            };
        } else {
            const content: any[] = [{ type: 'text', text: msg.content }];
            
            if (images && images.length > 0) {
                images.forEach(imageBase64 => {
                    const [mediaType, data] = imageBase64.split(',');
                    content.push({
                        type: 'image_url',
                        image_url: {
                            url: imageBase64
                        }
                    });
                });
            }
            
            return {
                role: msg.role,
                content: content.length === 1 ? content[0].text : content
            };
        }
    });

    let inputTokens = 0;
    let outputTokens = 0;
    let fullResponse = '';
    let stopHandlerFunction: () => void = () => {};
    let deltaCallback: (delta: string) => void = () => {};
    let errorCallback: (error: any) => void = () => {};
    let resolveResponse: (value: LLMResponse) => void = () => {};
    const responsePromise = new Promise<LLMResponse>((resolve) => {
        resolveResponse = resolve;
    });

    const appendText = (text: string) => {
        fullResponse += text;
        if(deltaCallback) {
            deltaCallback(text);
        }
    };
    
    const onDelta = (callback: (delta: string) => void) => {
        deltaCallback = callback;
    }

    const onError = (callback: (delta: string) => void) => {
        errorCallback = callback;
    }

    const start_time = Date.now();
    if (modelPreset.provider.includes('Anthropic')) {
        try {
            const client = new Anthropic({
                apiKey: modelPreset.apiKey,
                dangerouslyAllowBrowser: true,
            });

            const stream = client.messages.stream({
                // @ts-ignore
                messages: messageAndImageList,
                model: modelPreset.model,
                max_tokens: modelPreset.max_tokens || 4096,
                temperature: modelPreset.temperature,
            });

            stream.on("error", (error) => {
                errorCallback(error)
                throw new APIError(`Error prompting Anthropic stream: ${error.message}`);
            });

            stopHandlerFunction = () => {
                stream.controller.abort();
            };

            (async () => {
                try {
                    for await (const event of stream) {
                        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                            const text = event.delta.text;
                            appendText(text);

                        }
                    }

                    const finalMessage = await stream.finalMessage();
                    inputTokens = finalMessage.usage?.input_tokens || 0;
                    outputTokens = finalMessage.usage?.output_tokens || 0;

                    const cost = await getCost({modelPreset, inputTokens, outputTokens});
                    const duration = Date.now() - start_time;
                    const tokens_per_second = (outputTokens) / duration * 1000;

                    resolveResponse({ text: fullResponse, cost, tokens_per_second });
                } catch (error) {
                    errorCallback(error);
                }
            })();

        } catch (error) {
            errorCallback(error);
            if (error instanceof Error && !error.message.includes("Request was aborted")) {
                throw new APIError(`Error prompting Anthropic LLM: ${error.message}`);
            } else {
                throw new APIError(`Error prompting Anthropic LLM: ${error}`);
            }
        }
    } else if (modelPreset.provider.includes('Google')) {
        try {
            const genAI = new GoogleGenerativeAI(modelPreset.apiKey);
            const model = genAI.getGenerativeModel({ model: modelPreset.model });

            const formattedMessages = messageAndImageList.map(msg => {
                if (Array.isArray(msg.content)) {
                    return {
                        role: msg.role,
                        parts: msg.content.map(part => {
                            if (part.type === 'text') {
                                return { text: part.text };
                            } else if (part.type === 'image_url') {
                                return {
                                    inlineData: {
                                        data: part.image_url.url.split(',')[1],
                                        mimeType: part.image_url.url.split(',')[0].split(':')[1].split(';')[0]
                                    }
                                };
                            }
                            return part;
                        })
                    };
                } else {
                    return {
                        role: msg.role,
                        parts: [{ text: msg.content }]
                    };
                }
            });

            const abortController = new AbortController();
            const result = await model.generateContentStream({
                contents: formattedMessages,
                generationConfig: {
                    temperature: modelPreset.temperature,
                    maxOutputTokens: modelPreset.max_tokens,
                },
            }, {
                signal: abortController.signal
            });

            stopHandlerFunction = () => {
                abortController.abort();
                console.log("Aborting Google Generative AI");
            };

            (async () => {
                try {
                    for await (const chunk of result.stream) {
                        const text = chunk.text();
                        appendText(text);
                    }

                    const cost = await getCost({modelPreset, inputTokens: 0, outputTokens: 0});
                    const duration = Date.now() - start_time;
                    const tokens_per_second = 0;

                    resolveResponse({ text: fullResponse, cost, tokens_per_second });
                } catch (error) {
                    // @ts-ignore
                    if (error.name === 'AbortError') {
                        // Handle abort silently
                        console.log("AbortError, end silently?");
                        return;
                    }
                    console.log("errorCallback: in Google Generative AI:", error);
                    errorCallback(error);
                    throw new APIError(`Error prompting Google Generative AI: ${error}`);
                }
            })();

        } catch (error) {
            errorCallback(error);
            throw new APIError(`Error prompting Google Generative AI: ${error}`);
        }
    } else {
        try {
            const configuration = {
                apiKey: modelPreset.apiKey,
                dangerouslyAllowBrowser: true,
                baseURL: modelPreset.apiEndpoint,
                ...(modelPreset.apiEndpoint && { basePath: modelPreset.apiEndpoint })
            };
            const openai = new OpenAI(configuration);

            const messageAndImageList = messageList.map(msg => {
                const content: any[] = [{ type: 'text', text: msg.content }];
                
                if (images && images.length > 0) {
                    images.forEach(imageBase64 => {
                        const [mediaType, data] = imageBase64.split(',');
                        content.push({
                            type: 'image_url',
                            image_url: {
                                url: imageBase64
                            }
                        });
                    });
                }
                
                return {
                    role: msg.role,
                    content: content.length === 1 ? content[0].text : content
                };
            });

            const prompt_params: PromptParams = {
                model: modelPreset.model,
                messages: messageAndImageList,
                temperature: modelPreset.temperature || 0,
                stream: true,
                stream_options: {include_usage: true}
            }

            if(modelPreset.provider == "Mistral" || modelPreset.provider == "X AI") {
                delete prompt_params.stream_options;
            }

            if(modelPreset.provider == "OpenRouter" && modelPreset.model.match(/405b/)) {
                console.log("Using Fireworks for 405b");
                prompt_params.provider = {
                    "order": [
                        "Hyperbolic",
                    ],
                    allow_fallbacks: false
                }
            }

            if(modelPreset.provider.includes('OpenAI')) {
                if(modelPreset.model.startsWith("o")) {
                    prompt_params.max_completion_tokens = modelPreset.max_tokens;
                    prompt_params.reasoning_effort = "medium"
                    // console.log("O1 Max completion tokens:", prompt_params.max_completion_tokens);
                    prompt_params.temperature = 1;
                    prompt_params.stream = false;
                    delete prompt_params.stream_options;
                } else {
                    prompt_params.max_tokens = modelPreset.max_tokens;
                    prompt_params.stream_options = {"include_usage": true};
                }
            } else if(modelPreset.provider.includes('Deepseek') && modelPreset.model.startsWith("deepseek-reasoner")) {
                prompt_params.max_tokens = modelPreset.max_tokens;
                delete prompt_params.temperature;
                prompt_params.stream_options = {"include_usage": true};
            } else if(modelPreset.provider.includes('SambaNova') && modelPreset.model.startsWith("DeepSeek-R1")) {
                prompt_params.max_tokens = modelPreset.max_tokens;
                delete prompt_params.temperature;
                prompt_params.stream_options = {"include_usage": true};
            } else if(modelPreset.provider.includes('Fireworks')) {
                delete prompt_params.stream_options;
            } else {
                prompt_params.max_tokens = modelPreset.max_tokens;
            }


            fullResponse = '';
            // @ts-ignore
            const stream = await openai.chat.completions.create(prompt_params) as any;
            if(modelPreset.provider.includes('OpenAI') && modelPreset.model.startsWith("o")) {

                stopHandlerFunction = () => {
                    // stream.cancel();
                };
                // fullResponse = stream.choices[0]?.message.content || '';
                appendText(stream.choices[0]?.message.content || '');
                inputTokens = stream.usage?.prompt_tokens || 0;
                outputTokens = stream.usage?.completion_tokens || 0;
                resolveResponse({ text: fullResponse, cost: await getCost({modelPreset, inputTokens, outputTokens}), tokens_per_second: (outputTokens) / (Date.now() - start_time) * 1000 });
            } else {

                stopHandlerFunction = () => {
                    stream.controller.abort();
                };
                (async () => {
                    try {
                        for await (const chunk of stream) {
                            const delta = chunk.choices[0]?.delta?.content || '';
                            appendText(delta);

                            // fullResponse += delta; ??????????
                            
                            if(chunk.usage) {
                                inputTokens = chunk.usage.prompt_tokens || 0;
                                outputTokens = chunk.usage.completion_tokens || 0;
                            }
                        }
                        const cost = await getCost({modelPreset, inputTokens, outputTokens});
                        const duration = Date.now() - start_time;
                        const tokens_per_second = (outputTokens) / duration * 1000;
                        resolveResponse({ text: fullResponse, cost, tokens_per_second });
                    } catch (error) {
                        errorCallback(error);
                    }
                })();
            }
        } catch (error) {
            errorCallback(error);
            throw new APIError(`Error prompting OpenAI/Custom LLM: ${error}`);
        }
    }

    return {
        onDelta,
        stopHandler: stopHandlerFunction,
        response: () => responsePromise,
        onError
    };
}

export { promptLLM, APIError };
