import { useState, useCallback, useEffect, useRef } from "react";
import { BrowserRouter, Routes, Route, useNavigate, useParams } from "react-router-dom";
import { CopilotKit, useCopilotChat } from "@copilotkit/react-core";
import { GoogleOAuthProvider, useGoogleLogin } from "@react-oauth/google";
import { Sidebar } from "./components/Sidebar";
import { ChatContainer } from "./components/ChatContainer";
import "@copilotkit/react-ui/styles.css";
import "./App.css";

// Branding configuration from environment
const appBranding = {
  name: import.meta.env.VITE_APP_NAME || "BigQuery Agent",
  description: import.meta.env.VITE_APP_DESCRIPTION || "AI-powered analytics for your data",
  tagline: import.meta.env.VITE_APP_TAGLINE || "Sign in to access secure data insights.",
};

interface LocalMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: Date;
  status?: { code: string; description?: string };
}

interface Thread {
  id: string;
  title: string | null;
  updatedAt: string;
  _count: {
    messages: number;
  };
}

// Get this from Google Cloud Console -> APIs & Services -> Credentials
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";

/**
 * HistoryLoader - Hydrates chat history from the backend
 * Must be rendered inside CopilotKit to access the chat context
 */


function LoginScreen({ onLogin }: { onLogin: (token: string) => void }) {
  const [error, setError] = useState<string | null>(null);

  const login = useGoogleLogin({
    onSuccess: (tokenResponse) => {
      console.log("Google login success, access_token received");
      onLogin(tokenResponse.access_token);
    },
    onError: (errorResponse) => {
      console.error("Google login error:", errorResponse);
      setError("Login failed. Please try again.");
    },
    scope: "https://www.googleapis.com/auth/bigquery.readonly email profile openid",
  });

  return (
    <div className="login-container">
      <div className="login-card glass-panel">
        <h1 className="login-title">{appBranding.name}</h1>
        <p className="login-subtitle">
          {appBranding.description}<br />
          {appBranding.tagline}
        </p>

        <button onClick={() => login()} className="google-btn">
          <svg width="20" height="20" viewBox="0 0 48 48">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
          </svg>
          Sign in with Google
        </button>

        {error && (
          <p style={{ color: "#ef4444", marginTop: "16px", fontSize: "0.9rem" }}>{error}</p>
        )}
      </div>
    </div>
  );
}

/**
 * ChatView component that reads threadId from URL params
 */
function ChatView({ accessToken, onLogout, userEmail, onResolveUserEmail }: { accessToken: string; onLogout: () => void; userEmail: string | null; onResolveUserEmail: (email: string) => void }) {
  const { threadId: urlThreadId } = useParams<{ threadId?: string }>();
  const navigate = useNavigate();

  const [activeThreadId, setActiveThreadId] = useState<string | null>(() => {
    return urlThreadId || null;
  });

  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const inFlightRef = useRef(false);

  const fetchThreads = useCallback(async () => {
    if (!accessToken) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setThreadsLoading(true);
    try {
      const res = await fetch(`/api/threads/me`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(userEmail ? { "X-User-Email": userEmail } : {}),
        },
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.email && data.email !== userEmail) {
          onResolveUserEmail(data.email);
        }
        if (Array.isArray(data?.threads)) {
          setThreads(data.threads);
        }
        if (Array.isArray(data?.threads) && data.threads.length === 0 && userEmail) {
          const legacyRes = await fetch(`/api/threads?userId=${encodeURIComponent(userEmail)}`);
          if (legacyRes.ok) {
            const legacyData = await legacyRes.json();
            if (Array.isArray(legacyData) && legacyData.length > 0) {
              setThreads(legacyData);
            }
          }
        }
      } else if (userEmail) {
        const legacyRes = await fetch(`/api/threads?userId=${encodeURIComponent(userEmail)}`);
        if (legacyRes.ok) {
          const legacyData = await legacyRes.json();
          setThreads(legacyData);
        }
      }
    } catch (error: any) {
      console.error('Failed to load threads', error);
    } finally {
      setThreadsLoading(false);
      setHistoryLoaded(true);
      inFlightRef.current = false;
    }
  }, [accessToken, userEmail, onResolveUserEmail]);

  // Sync URL with active thread ID
  useEffect(() => {
    if (activeThreadId && activeThreadId !== urlThreadId) {
      navigate(`/chat/${activeThreadId}`, { replace: true });
    }
  }, [activeThreadId, urlThreadId, navigate]);

  // Update active thread if URL changes (e.g., user manually edits URL)
  useEffect(() => {
    if (urlThreadId && urlThreadId !== activeThreadId) {
      setActiveThreadId(urlThreadId);
    }
  }, [urlThreadId]);

  useEffect(() => {
    if (!accessToken) {
      setThreads([]);
      setHistoryLoaded(false);
      return;
    }
    fetchThreads();
  }, [accessToken, fetchThreads]);

  useEffect(() => {
    if (!accessToken) return;
    let timeoutId: number | undefined;
    let cancelled = false;

    const schedule = () => {
      if (cancelled) return;
      timeoutId = window.setTimeout(async () => {
        if (document.visibilityState === 'visible') {
          await fetchThreads();
        }
        schedule();
      }, 30000);
    };

    schedule();

    return () => {
      cancelled = true;
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [accessToken, fetchThreads]);

  useEffect(() => {
    if (urlThreadId || activeThreadId) return;
    if (!historyLoaded) return;
    if (threads.length > 0) {
      const latestThread = threads[0].id;
      setActiveThreadId(latestThread);
      navigate(`/chat/${latestThread}`, { replace: true });
    }
  }, [historyLoaded, threads, urlThreadId, activeThreadId, navigate]);

  const handleSelectThread = (threadId: string) => {
    console.log("Switching to thread:", threadId);
    setActiveThreadId(threadId);
    navigate(`/chat/${threadId}`);
  };

  const handleNewChat = () => {
    const newId = crypto.randomUUID();
    console.log("Starting new chat:", newId);
    setActiveThreadId(newId);
    navigate(`/chat/${newId}`);
  };

  const chatReady = historyLoaded && !!activeThreadId;

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar
        userId={userEmail}
        activeThreadId={activeThreadId}
        threads={threads}
        loading={threadsLoading && threads.length === 0}
        disableActions={!historyLoaded}
        onSelectThread={handleSelectThread}
        onNewChat={handleNewChat}
      />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {/* 
          Key by threadId to force CopilotKit to reset when switching threads.
          This ensures a clean session context for each conversation.
        */}
        <div className="copilot-chat-container" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
          <header className="app-header glass-panel">
            <div className="app-title">
              <span style={{ fontSize: "1.5rem" }}>{import.meta.env.VITE_APP_ICON || "\u{1F9EC}"}</span>
              <span>{appBranding.name}</span>
            </div>

            <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
              <div className="status-badge">
                <div className="status-dot"></div>
                <span>Agent Active</span>
              </div>

              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginRight: '8px' }}>
                {userEmail || 'Loading...'}
              </div>

              <button onClick={onLogout} className="sign-out-btn">
                Sign Out
              </button>
            </div>
          </header>

          <main style={{ flex: 1, position: "relative", display: "flex", flexDirection: "column", overflow: "auto" }}>
            {!chatReady && (
              <div className="chat-placeholder">
                {!historyLoaded && (
                  <div className="chat-placeholder-card glass-card">
                    <div className="chat-placeholder-title">Loading conversation history...</div>
                    <div className="chat-placeholder-subtitle">Hang tight while we sync your threads.</div>
                  </div>
                )}

                {historyLoaded && (
                  <div className="chat-placeholder-card glass-card">
                    <div className="chat-placeholder-title">No conversation selected</div>
                    <div className="chat-placeholder-subtitle">Pick a thread from the left or start a new chat.</div>
                    <button className="chat-placeholder-button" onClick={handleNewChat}>
                      + Create New Chat
                    </button>
                  </div>
                )}
              </div>
            )}

            {chatReady && (
              <CopilotKit
                key={activeThreadId}
                runtimeUrl="/copilotkit"
                threadId={activeThreadId}
                headers={{
                  Authorization: `Bearer ${accessToken}`,
                  ...(userEmail ? { "X-User-Email": userEmail } : {})
                }}
                properties={{
                  userEmail: userEmail || undefined,
                  authToken: accessToken,
                }}
              >
                <ChatContainer />
              </CopilotKit>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function AuthenticatedApp({ accessToken, onLogout, userEmail, onResolveUserEmail }: { accessToken: string; onLogout: () => void; userEmail: string | null; onResolveUserEmail: (email: string) => void }) {
  return (
    <Routes>
      <Route path="/chat/:threadId" element={<ChatView accessToken={accessToken} onLogout={onLogout} userEmail={userEmail} onResolveUserEmail={onResolveUserEmail} />} />
      <Route path="*" element={<ChatView accessToken={accessToken} onLogout={onLogout} userEmail={userEmail} onResolveUserEmail={onResolveUserEmail} />} />
    </Routes>
  );
}

function App() {
  // DEV MODE: Hardcode auth for debugging
  const [accessToken, setAccessToken] = useState<string | null>(localStorage.getItem("google_access_token"));
  const [userEmail, setUserEmail] = useState<string | null>(localStorage.getItem("google_user_email"));

  const fetchUserProfile = async (token: string) => {
    try {
      const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setUserEmail(data.email);
        if (data.email) {
          localStorage.setItem("google_user_email", data.email);
        }
      } else {
        // Token might be invalid/expired
        if (res.status === 401) handleLogout();
      }
    } catch (e) {
      console.error("Failed to fetch user profile", e);
    }
  };

  useEffect(() => {
    if (accessToken) {
      fetchUserProfile(accessToken);
    }
  }, [accessToken]);

  const handleLogin = useCallback((token: string) => {
    localStorage.setItem("google_access_token", token);
    setAccessToken(token);
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem("google_access_token");
    localStorage.removeItem("google_user_email");
    setAccessToken(null);
    setUserEmail(null);
  }, []);

  if (!GOOGLE_CLIENT_ID) {
    return (
      <div style={{ padding: 40, color: "#ef4444", textAlign: "center", background: "#1e1b4b", minHeight: "100vh" }}>
        <div className="glass-panel" style={{ padding: 40, borderRadius: 12, display: "inline-block" }}>
          <h2>Configuration Error</h2>
          <p>VITE_GOOGLE_CLIENT_ID environment variable is not set.</p>
          <code style={{ background: "rgba(0,0,0,0.3)", padding: "4px 8px", borderRadius: 4 }}>
            client/.env
          </code>
        </div>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
        {accessToken ? (
          <AuthenticatedApp accessToken={accessToken} onLogout={handleLogout} userEmail={userEmail} onResolveUserEmail={setUserEmail} />
        ) : (
          <LoginScreen onLogin={handleLogin} />
        )}
      </GoogleOAuthProvider>
    </BrowserRouter>
  );
}

export default App;
