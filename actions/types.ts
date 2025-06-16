export interface Action {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: Record<string, any>;
        required?: string[];
    };
    handler: (params: {
        parameters: any;
        sessionName: string;
    }) => Promise<void>;
} 