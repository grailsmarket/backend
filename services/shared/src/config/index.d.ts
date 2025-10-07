export declare const config: {
    database: {
        url: string;
        maxConnections: number;
        ssl: boolean;
    };
    redis: {
        url: string;
        ttl: number;
    };
    elasticsearch: {
        url: string;
        index: string;
    };
    blockchain: {
        rpcUrl: string;
        chainId: number;
        ensRegistrarAddress: string;
        seaportAddress: string;
        confirmations: number;
        startBlock?: number | undefined;
    };
    opensea: {
        streamUrl: string;
        apiKey?: string | undefined;
    };
    api: {
        port: number;
        host: string;
        corsOrigins: string[];
        rateLimitMax: number;
        rateLimitWindow: number;
    };
    monitoring: {
        logLevel: "error" | "warn" | "info" | "debug";
        sentryDsn?: string | undefined;
    };
    jwt: {
        expiresIn: string;
        secret?: string | undefined;
    };
};
export default config;
//# sourceMappingURL=index.d.ts.map