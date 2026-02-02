import { useState, useCallback } from "react";
import { CopilotKit } from "@copilotkit/react-core";
import { CopilotChat } from "@copilotkit/react-ui";
import { GoogleOAuthProvider, useGoogleLogin } from "@react-oauth/google";
import "@copilotkit/react-ui/styles.css";

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
    <div style={{
      height: "100vh",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "#f5f5f5",
      fontFamily: "system-ui, sans-serif",
    }}>
      <div style={{
        backgroundColor: "white",
        padding: "40px",
        borderRadius: "12px",
        boxShadow: "0 2px 10px rgba(0,0,0,0.1)",
        textAlign: "center",
        maxWidth: "400px",
      }}>
        <h1 style={{ margin: "0 0 8px 0", color: "#1a1a1a" }}>
          Clinical Research Agent
        </h1>
        <p style={{ margin: "0 0 24px 0", color: "#666" }}>
          Sign in to query clinical data with your authorized permissions.
        </p>

        <button
          onClick={() => login()}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "12px",
            width: "100%",
            padding: "12px 24px",
            fontSize: "16px",
            fontWeight: 500,
            color: "#1a1a1a",
            backgroundColor: "white",
            border: "1px solid #ddd",
            borderRadius: "8px",
            cursor: "pointer",
            transition: "background-color 0.2s",
          }}
          onMouseOver={(e) => e.currentTarget.style.backgroundColor = "#f8f8f8"}
          onMouseOut={(e) => e.currentTarget.style.backgroundColor = "white"}
        >
          <svg width="20" height="20" viewBox="0 0 48 48">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
          </svg>
          Sign in with Google
        </button>

        {error && (
          <p style={{ color: "#dc2626", marginTop: "16px" }}>{error}</p>
        )}

        <p style={{ marginTop: "24px", fontSize: "12px", color: "#999" }}>
          Your queries will be executed with your BigQuery permissions.
        </p>
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
      <div
        className="copilot-chat-container"
        style={{
          height: "100vh",
          width: "100vw",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "8px 16px",
          backgroundColor: "#f8f8f8",
          borderBottom: "1px solid #eee",
        }}>
          <span style={{ fontWeight: 500 }}>Clinical Research Agent</span>
          <button
            onClick={onLogout}
            style={{
              padding: "6px 12px",
              fontSize: "14px",
              backgroundColor: "transparent",
              border: "1px solid #ddd",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Sign Out
          </button>
        </div>
        <CopilotChat
          className="flex-1"
          labels={{
            title: "Clinical Research Agent",
            initial: "How can I help you with the clinical data?",
          }}
        />
      </div>
    </CopilotKit>
  );
}

function App() {
  const [accessToken, setAccessToken] = useState<string | null>(null);

  const handleLogin = useCallback((token: string) => {
    setAccessToken(token);
  }, []);

  const handleLogout = useCallback(() => {
    setAccessToken(null);
  }, []);

  if (!GOOGLE_CLIENT_ID) {
    return (
      <div style={{ padding: 20, color: "red" }}>
        Error: VITE_GOOGLE_CLIENT_ID environment variable is not set.
        <br />
        Please add it to your .env file in the client directory.
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
