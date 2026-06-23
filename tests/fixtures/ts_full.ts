
export interface RequestPayload {
    id: string;
    timestamp: number;
    data: any;
}

export interface ResponsePayload {
    success: boolean;
    data?: any;
    error?: string;
}

export class ApiController {
    private endpoints: Map<string, Function>;

    constructor() {
        this.endpoints = new Map();
    }

    public registerEndpoint(path: string, handler: (req: RequestPayload) => Promise<ResponsePayload>): void {
        if (this.endpoints.has(path)) {
            throw new Error(`Endpoint ${path} already registered`);
        }
        this.endpoints.set(path, handler);
    }

    public async handleRequest(path: string, payload: RequestPayload): Promise<ResponsePayload> {
        try {
            const handler = this.endpoints.get(path);
            if (!handler) {
                return { success: false, error: 'Endpoint not found' };
            }
            const result = await handler(payload);
            return result;
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }
}

const api = new ApiController();
api.registerEndpoint('/ping', async (req) => {
    return { success: true, data: { pong: req.timestamp } };
});
