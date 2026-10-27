import type { TokenSet as Tokens, Proposal } from '../../app/shared/model.js';
// Contrat de conception, aucune connexion ou écriture distante en V1.
export interface FigmaScope {
  fileKey: string;
  variableIds: string[];
  revision: string;
}
export interface FigmaConnector {
  read(scope: FigmaScope): Promise<{ tokens: Tokens; revision: string }>;
  propose(
    scope: FigmaScope,
    proposal: Proposal,
  ): Promise<{ diff: string; approvalId: string }>;
  // L'implémentation future doit consommer une validation liée au hash et à la révision.
  applyApproved(
    approvalId: string,
  ): Promise<{ revision: string; readback: Tokens }>;
}
export const figmaStatus = {
  connected: false,
  label: 'Figma non connecté',
  writeEnabled: false,
} as const;
