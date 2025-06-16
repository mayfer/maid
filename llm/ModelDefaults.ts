import { Provider } from './Interfaces';
import { refreshProviderModels } from './fetchModels';

export const providerOptions = [
  'OpenAI',
  'Anthropic',
  'OpenRouter',
  'llama.cpp',
  'ollama',
  'Groq',
  'SambaNova',
  'Cerebras',
  'custom',
];

export const defaultProviders: Provider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    apiEndpoint: 'https://api.openai.com/v1/',
    apiKey: Bun.env.OPENAI_API_KEY || '',
    models: []
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    apiEndpoint: 'https://api.anthropic.com/v1/',
    apiKey: Bun.env.ANTHROPIC_API_KEY || '',
    models: []
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    apiEndpoint: 'https://openrouter.ai/api/v1/',
    apiKey: '',
    models: []
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp',
    apiEndpoint: '',
    apiKey: '',
    models: []
  },
  {
    id: 'ollama',
    name: 'ollama',
    apiEndpoint: '',
    apiKey: '',
    models: []
  },
  {
    id: 'groq',
    name: 'Groq',
    apiEndpoint: 'https://api.groq.com/v1/',
    apiKey: '',
    models: []
  },
  {
    id: 'sambanova',
    name: 'SambaNova',
    apiEndpoint: '',
    apiKey: '',
    models: []
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    apiEndpoint: '',
    apiKey: '',
    models: []
  }
];

export async function getProvidersWithLatestModels(): Promise<Provider[]> {
  return await refreshProviderModels(defaultProviders);
}
