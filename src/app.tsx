import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/button/Button";
import { Card } from "@/components/card/Card";
import { Avatar } from "@/components/avatar/Avatar";
import { Textarea } from "@/components/textarea/Textarea";
import { MemoizedMarkdown } from "@/components/memoized-markdown";
import {
  ArrowsClockwise,
  Microphone,
  Stop,
  PaperPlaneTilt,
  Trash
} from "@phosphor-icons/react";

type ChatRole = "user" | "assistant";

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt?: string;
}

interface ChatResponse {
  conversationId: string;
  reply: string;
  summary: string | null;
  metadata: {
    messageCount: number;
    receivedAt: string;
  };
}

interface HistoryResponse {
  conversationId: string;
  summary: string | null;
  lastUpdated: string | null;
  messages: Array<{
    id: string;
    role: ChatRole | string;
    content: string;
    createdAt: number;
  }>;
}

const CONVERSATION_STORAGE_KEY = "cf.conversation.id";

const createConversationId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const formatIsoTime = (iso?: string | null) => {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
};

const ensureChatRole = (input: string): ChatRole =>
  input === "user" ? "user" : "assistant";

const ALLOWED_AUDIO_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/wav",
  "audio/webm",
  "audio/ogg"
]);

const normalizeMimeType = (input?: string | null): string | undefined => {
  if (!input) return undefined;
  const [base] = input.toLowerCase().split(";");
  if (ALLOWED_AUDIO_MIME_TYPES.has(base)) {
    return base;
  }
  if (base === "audio/x-wav") {
    return "audio/wav";
  }
  if (base === "audio/mp3") {
    return "audio/mpeg";
  }
  return undefined;
};

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unable to read audio data"));
        return;
      }
      const base64 = result.split(",").pop();
      if (!base64) {
        reject(new Error("Audio data missing"));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error("File read failed"));
    reader.readAsDataURL(blob);
  });

const fileToBase64 = async (
  file: File
): Promise<{ base64: string; mimeType: string; name: string }> => {
  const base64 = await blobToBase64(file);
  const normalizedMimeType = normalizeMimeType(file.type) ?? "audio/webm";
  return {
    base64,
    mimeType: normalizedMimeType,
    name: file.name || `upload-${Date.now()}`
  };
};

interface VoiceAttachment {
  base64: string;
  mimeType: string;
  name: string;
  durationSeconds?: number;
}

const roundDuration = (seconds: number) =>
  Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));

const formatDuration = (seconds: number) => {
  const clamped = roundDuration(seconds);
  const mins = Math.floor(clamped / 60)
    .toString()
    .padStart(2, "0");
  const secs = Math.floor(clamped % 60)
    .toString()
    .padStart(2, "0");
  return `${mins}:${secs}`;
};

const supportsMediaRecording = () =>
  typeof window !== "undefined" &&
  typeof navigator !== "undefined" &&
  "mediaDevices" in navigator &&
  typeof navigator.mediaDevices.getUserMedia === "function" &&
  typeof window.MediaRecorder !== "undefined";

const stopStreamTracks = (stream: MediaStream | null) => {
  stream?.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch (error) {
      console.warn("Failed to stop audio track", error);
    }
  });
};

export default function ChatApp() {
  const [conversationId, setConversationId] = useState<string>(() => {
    if (typeof window === "undefined") {
      return createConversationId();
    }
    const stored = window.localStorage.getItem(CONVERSATION_STORAGE_KEY);
    if (stored) return stored;
    const generated = createConversationId();
    window.localStorage.setItem(CONVERSATION_STORAGE_KEY, generated);
    return generated;
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLastUpdated, setSummaryLastUpdated] = useState<string | null>(
    null
  );
  const [metadata, setMetadata] = useState<ChatResponse["metadata"] | null>(null);
  const [input, setInput] = useState("");
  const [voiceAttachment, setVoiceAttachment] = useState<VoiceAttachment | null>(
    null
  );
  const [isSending, setIsSending] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recorderSupported] = useState(() => supportsMediaRecording());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordingSecondsRef = useRef(0);
  const recordingIntervalRef = useRef<number | null>(null);
  const discardRecordingRef = useRef(false);

  const refreshHistory = useCallback(
    async (id: string) => {
      setIsHistoryLoading(true);
      try {
        const response = await fetch(`/api/history?conversationId=${id}`);
        if (!response.ok) {
          const problem = await response.json().catch(() => ({}));
          throw new Error(
            typeof problem.error === "string"
              ? problem.error
              : "Unable to load conversation history"
          );
        }
        const data: HistoryResponse = await response.json();
        const mapped: ChatMessage[] = data.messages.map((msg) => ({
          id: msg.id,
          role: ensureChatRole(msg.role),
          content: msg.content,
          createdAt: new Date(msg.createdAt).toISOString()
        }));

        setMessages(mapped);
        setSummary(data.summary ?? null);
        setSummaryLastUpdated(data.lastUpdated ?? null);
      } catch (err) {
        console.error(err);
        setError(
          err instanceof Error ? err.message : "Unexpected error loading history"
        );
      } finally {
        setIsHistoryLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    refreshHistory(conversationId).catch((err) => {
      console.error("History refresh failed", err);
    });
  }, [conversationId, refreshHistory]);

  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length]);

  const clearVoiceAttachment = useCallback(() => {
    setVoiceAttachment(null);
    setRecordingSeconds(0);
    recordingSecondsRef.current = 0;
    setRecordingError(null);
    discardRecordingRef.current = false;
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  const stopRecordingInternal = useCallback(() => {
    if (recordingIntervalRef.current !== null) {
      window.clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.stop();
      } catch (error) {
        console.warn("Unable to stop recorder", error);
      }
    }
    stopStreamTracks(mediaStreamRef.current);
    mediaStreamRef.current = null;
  }, []);

  const startRecording = useCallback(async () => {
    if (!supportsMediaRecording()) {
      setRecordingError("This browser does not support microphone recording.");
      return;
    }
    if (isRecording) {
      stopRecordingInternal();
      return;
    }

    try {
      discardRecordingRef.current = false;
      setRecordingError(null);
      setVoiceAttachment(null);
      setRecordingSeconds(0);
      recordingSecondsRef.current = 0;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chosenMimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/ogg";
      const recorder = new MediaRecorder(stream, { mimeType: chosenMimeType });
      const chunks: BlobPart[] = [];

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      recorder.onerror = (event) => {
        console.error("MediaRecorder error", event.error);
        setRecordingError(
          event.error?.message ?? "Unexpected microphone error occurred."
        );
        setIsRecording(false);
        stopRecordingInternal();
      };

      recorder.onstop = async () => {
        try {
          if (discardRecordingRef.current) {
            clearVoiceAttachment();
          } else {
          const blob = new Blob(chunks, { type: chosenMimeType });
            const base64 = await blobToBase64(blob);
            const normalizedMimeType =
              normalizeMimeType(chosenMimeType) ?? "audio/webm";
            setVoiceAttachment({
              base64,
              mimeType: normalizedMimeType,
              name: `recording-${new Date().toISOString()}.webm`,
              durationSeconds: recordingSecondsRef.current
            });
          }
        } catch (err) {
          console.error("Failed to read recording", err);
          setRecordingError(
            err instanceof Error ? err.message : "Unable to read audio recording."
          );
        } finally {
          setIsRecording(false);
          setRecordingSeconds(0);
          recordingSecondsRef.current = 0;
          discardRecordingRef.current = false;
          stopStreamTracks(stream);
        }
      };

      mediaRecorderRef.current = recorder;
      mediaStreamRef.current = stream;
      recorder.start();
      setIsRecording(true);
      recordingIntervalRef.current = window.setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
        recordingSecondsRef.current += 1;
      }, 1000);
    } catch (err) {
      console.error("Microphone access denied", err);
      setRecordingError(
        err instanceof Error ? err.message : "Unable to access the microphone."
      );
      setIsRecording(false);
      recordingSecondsRef.current = 0;
      stopRecordingInternal();
    }
  }, [isRecording, stopRecordingInternal, clearVoiceAttachment]);

  const stopRecording = useCallback(
    (options?: { discard?: boolean }) => {
      if (!isRecording) {
        return;
      }
      discardRecordingRef.current = options?.discard ?? false;
      stopRecordingInternal();
    },
    [isRecording, stopRecordingInternal]
  );

  useEffect(() => {
    return () => {
      if (recordingIntervalRef.current !== null) {
        window.clearInterval(recordingIntervalRef.current);
      }
      if (mediaRecorderRef.current?.state !== "inactive") {
        try {
          mediaRecorderRef.current.stop();
        } catch (error) {
          console.warn("Failed to stop recorder during cleanup", error);
        }
      }
      recordingSecondsRef.current = 0;
      discardRecordingRef.current = false;
      stopStreamTracks(mediaStreamRef.current);
    };
  }, []);

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const [file] = Array.from(event.target.files ?? []);
      if (!file) {
        setVoiceAttachment(null);
        recordingSecondsRef.current = 0;
        return;
      }
      try {
        const audio = await fileToBase64(file);
        setVoiceAttachment({
          ...audio,
          durationSeconds: undefined
        });
        recordingSecondsRef.current = 0;
        setRecordingError(null);
      } catch (err) {
        console.error(err);
        setRecordingError(
          err instanceof Error ? err.message : "Unable to read selected audio file."
        );
      }
    },
    []
  );

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = input.trim();
      if (!trimmed && !voiceAttachment) {
        setError("Provide a text message or attach an audio clip.");
        return;
      }

      if (isRecording) {
        stopRecording();
        setError("Recording in progress. Stop recording before sending.");
        return;
      }

      setIsSending(true);
      setError(null);

      try {
        const payload: Record<string, unknown> = {
          conversationId,
          metadata: { source: "web" }
        };

        if (trimmed) {
          payload.message = trimmed;
        }

        if (voiceAttachment) {
          payload.voice = voiceAttachment.base64;
          payload.voiceMimeType = voiceAttachment.mimeType;
        }

        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const problem = await response.json().catch(() => ({}));
          const details =
            typeof problem.details === "string"
              ? problem.details
              : typeof problem.error === "string"
                ? problem.error
                : "The chat API rejected the request";
          throw new Error(details);
        }

        const data: ChatResponse = await response.json();
        setMetadata(data.metadata ?? null);
        setInput("");
        clearVoiceAttachment();
        await refreshHistory(data.conversationId);
      } catch (err) {
        console.error(err);
        setError(err instanceof Error ? err.message : "Unable to send message");
      } finally {
        setIsSending(false);
      }
    },
    [
      conversationId,
      input,
      voiceAttachment,
      refreshHistory,
      clearVoiceAttachment,
      isRecording,
      stopRecording
    ]
  );

  const handleNewConversation = () => {
    if (isRecording) {
      stopRecording({ discard: true });
    }
    const nextId = createConversationId();
    setConversationId(nextId);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(CONVERSATION_STORAGE_KEY, nextId);
    }
    setMessages([]);
    setSummary(null);
    setSummaryLastUpdated(null);
    setMetadata(null);
    setInput("");
    clearVoiceAttachment();
    setError(null);
  };

  const summaryTimestamp = useMemo(
    () => formatIsoTime(summaryLastUpdated),
    [summaryLastUpdated]
  );
  const lastMessageTimestamp = useMemo(
    () => formatIsoTime(metadata?.receivedAt ?? messages.at(-1)?.createdAt),
    [metadata, messages]
  );

  return (
    <main className="min-h-screen bg-neutral-100 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
      <div className="max-w-3xl mx-auto px-4 py-10 space-y-6">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">AI Conversation</h1>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Conversation ID: <code>{conversationId}</code>
            </p>
            {lastMessageTimestamp && (
              <p className="text-xs text-neutral-500 dark:text-neutral-500">
                Last activity: {lastMessageTimestamp}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="md"
              shape="square"
              className="rounded-full"
              onClick={() => refreshHistory(conversationId)}
              disabled={isHistoryLoading}
              aria-label="Refresh conversation history"
            >
              <ArrowsClockwise size={18} />
            </Button>
            <Button
              variant="ghost"
              size="md"
              shape="square"
              className="rounded-full"
              onClick={handleNewConversation}
              aria-label="Start new conversation"
            >
              <Trash size={18} />
            </Button>
          </div>
        </header>

        {error && (
          <Card className="p-4 border border-red-400 bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-200 dark:border-red-800">
            <p className="text-sm">{error}</p>
          </Card>
        )}
        {recordingError && (
          <Card className="p-4 border border-yellow-400 bg-yellow-50 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-100 dark:border-yellow-700">
            <p className="text-sm">{recordingError}</p>
          </Card>
        )}

        <Card className="p-4 space-y-3 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800">
          <div className="flex justify-between items-center">
            <h2 className="font-semibold text-lg">Conversation Summary</h2>
            {summaryTimestamp && (
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                Updated {summaryTimestamp}
              </span>
            )}
          </div>
          {isHistoryLoading && !summary ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Loading summary…
            </p>
          ) : summary ? (
            <MemoizedMarkdown id="conversation-summary" content={summary} />
          ) : (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              No summary yet. Share more details to build context.
            </p>
          )}
        </Card>

        <section className="space-y-4 max-h-[55vh] overflow-y-auto pr-1">
          {messages.length === 0 && !isHistoryLoading ? (
            <Card className="p-6 text-center bg-white dark:bg-neutral-900 border border-dashed border-neutral-300 dark:border-neutral-700">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                Start the conversation with a message or upload an audio clip.
              </p>
            </Card>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${
                  message.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`flex gap-3 max-w-[80%] ${
                    message.role === "user" ? "flex-row-reverse" : "flex-row"
                  }`}
                >
                  <Avatar
                    username={message.role === "user" ? "You" : "AI"}
                    className="self-start"
                  />
                  <Card className="p-3 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800">
                    <MemoizedMarkdown
                      id={`${message.id}-content`}
                      content={message.content}
                    />
                    {message.createdAt && (
                      <p className="mt-2 text-[11px] text-neutral-500 dark:text-neutral-500">
                        {formatIsoTime(message.createdAt)}
                      </p>
                    )}
                  </Card>
                </div>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </section>

        <form
          className="sticky bottom-4 flex flex-col gap-3 bg-white/70 dark:bg-neutral-950/70 backdrop-blur-md p-4 rounded-md border border-neutral-200 dark:border-neutral-800"
          onSubmit={handleSubmit}
        >
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Share an update or ask a question…"
            rows={4}
          />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={handleFileSelect}
              />
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="md"
                  onClick={() => {
                    if (isRecording) {
                      stopRecording();
                    } else {
                      startRecording();
                    }
                  }}
                  disabled={isSending || (!recorderSupported && !isRecording)}
                >
                  {isRecording ? (
                    <>
                      <Stop size={18} className="mr-2 text-red-500" />
                      Stop recording ({formatDuration(recordingSeconds)})
                    </>
                  ) : (
                    <>
                      <Microphone size={18} className="mr-2 text-red-500" />
                      {voiceAttachment ? "Re-record voice" : "Record voice"}
                    </>
                  )}
                </Button>
                {!isRecording && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="md"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isSending}
                  >
                    Upload audio
                  </Button>
                )}
                {voiceAttachment && !isRecording && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clearVoiceAttachment}
                    disabled={isSending}
                  >
                    Remove audio
                  </Button>
                )}
              </div>
              {voiceAttachment && !isRecording && (
                <span className="text-xs text-neutral-600 dark:text-neutral-400">
                  {voiceAttachment.name}
                  {voiceAttachment.durationSeconds !== undefined
                    ? ` • ${formatDuration(voiceAttachment.durationSeconds)}`
                    : ""}
                </span>
              )}
              {!recorderSupported && (
                <span className="text-xs text-neutral-500 dark:text-neutral-500">
                  Microphone recording is not supported in this browser. Upload audio instead.
                </span>
              )}
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                type="button"
                variant="ghost"
                size="md"
                onClick={() => {
                  if (isRecording) {
                    stopRecording({ discard: true });
                  }
                  setInput("");
                  clearVoiceAttachment();
                }}
                disabled={isSending && !isRecording}
              >
                Clear
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="md"
                disabled={isSending || isRecording}
              >
                {isSending ? "Sending…" : <PaperPlaneTilt size={18} />}
              </Button>
            </div>
          </div>
        </form>
      </div>
    </main>
  );
}
