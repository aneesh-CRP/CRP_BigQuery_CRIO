import { useState, useCallback } from "react";
import { CopilotKit } from "@copilotkit/react-core";
import { CopilotChat } from "@copilotkit/react-ui";
import { GoogleOAuthProvider, useGoogleLogin } from "@react-oauth/google";
import "@copilotkit/react-ui/styles.css";
import "./App.css";

// Get this from Google Cloud Console -> APIs & Services -> Credentials
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";

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
    scope: "https://www.googleapis.com/auth/bigquery.readonly",
  });

  return (
    <div className="login-container">
      <div className="login-card glass-panel">
        <h1 className="login-title">Clinical Research Agent</h1>
        <p className="login-subtitle">
          AI-powered analytics for your clinical data.<br />
          Sign in to access secure BigQuery insights.
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

function AuthenticatedApp({ accessToken, onLogout }: { accessToken: string; onLogout: () => void }) {
  return (
    <CopilotKit
      runtimeUrl="/copilotkit"
      headers={{ Authorization: `Bearer ${accessToken}` }}
    >
      <div className="copilot-chat-container" style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
        <header className="app-header glass-panel">
          <div className="app-title">
            <span style={{ fontSize: "1.5rem" }}>🧬</span>
            <span>Clinical Research Agent</span>
          </div>

          <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
            <div className="status-badge">
              <div className="status-dot"></div>
              <span>Agent Active</span>
            </div>

            <button onClick={onLogout} className="sign-out-btn">
              Sign Out
            </button>
          </div>
        </header>

        <main style={{ flex: 1, position: "relative", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <CopilotChat
            className="flex-1"
            labels={{
              title: " ",
              initial: "Hello! I'm your Clinical Research Assistant. Ask me about patient data, studies, or findings.",
            }}
          />
        </main>
      </div>
    </CopilotKit>
  );
}

function App() {
  const [accessToken, setAccessToken] = useState<string | null>(() => localStorage.getItem("google_access_token"));

  const handleLogin = useCallback((token: string) => {
    localStorage.setItem("google_access_token", token);
    setAccessToken(token);
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem("google_access_token");
    setAccessToken(null);
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
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      {accessToken ? (
        <AuthenticatedApp accessToken={accessToken} onLogout={handleLogout} />
      ) : (
        <LoginScreen onLogin={handleLogin} />
      )}
    </GoogleOAuthProvider>
  );
}

export default App;
