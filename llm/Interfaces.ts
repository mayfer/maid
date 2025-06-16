export interface FileNode {
    name: string;
    path: string;
    is_directory: boolean;
    children: FileNode[];
  }
  
  export interface FileBrowserProps {
    currentPath: string;
    directoryTree: FileNode[];
    ignoredPaths: string[];
  }
  
  export interface Model {
    id: string;
    name: string;
    temperature?: number;
    max_tokens?: number;
    featured?: boolean;
    input_cpm?: number;
    output_cpm?: number;
  }
  
  export interface Provider {
    id: string;
    name: string;
    apiEndpoint: string;
    apiKey: string;
    models: Model[];
  }
  
  export interface ModelPreset {
    provider_id: string;
    model_id: string;
    name: string;
    provider: string;
    apiEndpoint: string;
    apiKey: string;
    model: string;
    temperature?: number;
    max_tokens?: number;
    input_cpm?: number;
    output_cpm?: number;
  }
  
  export interface DbSettingsInterface {
    dbType: 'postgres' | 'mysql';
    username: string;
    password: string;
    host: string;
    port: string;
    database: string;
    schema: string;
    useSSHTunnel: boolean;
    sshUser: string;
    sshHost: string;
    sshPassword: string;
    sshPrivateKey: string;
  }