// Compatibility with the dedicated Dots route of bridge protocol v16.
export const PROTOCOL_VERSION = 16;
export type EchoPhase = "idle" | "listening" | "transcribing" | "thinking" | "speaking" | "error";
export interface EchoConfigSnapshot {
  dedicatedDots: boolean; dotsReady: boolean; transcriptReview: boolean;
  asrReady: boolean;
}
export type ServerMessage =
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "echo.snapshot"; snapshot: { sessionId: string; phase: EchoPhase; config: EchoConfigSnapshot } }
  | { type: "echo.state"; turnId: number; phase: EchoPhase; message?: string }
  | { type: "echo.transcript"; turnId: number; text: string; final: boolean; awaitingConfirmation?: boolean }
  | { type: "echo.reply"; turnId: number; text: string; final: boolean; provisional?: boolean }
  | { type: "echo.dots.incoming" | "echo.notification"; turnId: number; notificationId: string; content: string; createdAt: number }
  | { type: "echo.done"; turnId: number }
  | { type: "echo.error"; turnId: number; message: string; recoverable: boolean };
