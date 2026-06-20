import { type RemoteAgentConfig } from './agent-config';
export interface AgentClientHooks {
    onRemoteConfig?: (config: RemoteAgentConfig, version: number) => void | Promise<void>;
}
export declare function startAgentClient(hooks?: AgentClientHooks): () => void;
//# sourceMappingURL=agent-client.d.ts.map