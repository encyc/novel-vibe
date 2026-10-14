import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api/client";
import { AuthenticatedApp } from "./app/AuthenticatedApp";
import { ArticleDetailPage } from "./community/ArticleDetailPage";
import { ArticleEditorPage } from "./community/ArticleEditorPage";
import { AuthorProfilePage } from "./community/AuthorProfilePage";
import { CommunityPage } from "./community/CommunityPage";
import { MyFeedbackPage } from "./community/MyFeedbackPage";
import { LoginView } from "./components/LoginView";
import { localizeApiError } from "./i18n/error-message";
import { useInterfaceLocale } from "./i18n/LocaleProvider";
import { LOCAL_IDENTITY_FALLBACK, LocalModeProvider } from "./local-mode";
import { ReferralCampaignNotice } from "./referral/ReferralCampaignNotice";
import type { User } from "./types";

export function App() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const { adoptProfileLocale } = useInterfaceLocale();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [localMode, setLocalMode] = useState(false);

  const handleSignOut = useCallback(() => {
    queryClient.clear();
    setUser(null);
  }, [queryClient]);

  const reconcileUser = useCallback(async (nextUser: User) => {
    const profile = await api.getProfile();
    await adoptProfileLocale(profile.locale);
    setUser(nextUser);
  }, [adoptProfileLocale]);

  useEffect(() => {
    let cancelled = false;

    // Hosted path — unchanged: reading the session IS the login gate.
    const readHostedSession = () => {
      api.me()
        .then(async (nextUser) => {
          if (nextUser && !cancelled) await reconcileUser(nextUser);
          else if (!cancelled) setUser(null);
        })
        .catch((err) => {
          if (!cancelled) setError(localizeApiError(err, "auth.readSessionFailed"));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    // Local-first path: there is no sign-in server, so entering the app must not
    // depend on any read succeeding. The identity comes from the BFF; a failed
    // /api/me or /api/profile still enters with a minimal local user.
    const enterLocalMode = () => {
      setLocalMode(true);
      api.me()
        .then(async (nextUser) => {
          const resolved = nextUser ?? LOCAL_IDENTITY_FALLBACK;
          if (cancelled) return;
          try {
            await reconcileUser(resolved);
          } catch {
            if (!cancelled) setUser(resolved);
          }
        })
        .catch(() => {
          if (!cancelled) setUser(LOCAL_IDENTITY_FALLBACK);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    api.getMode()
      .then((mode) => {
        if (cancelled) return;
        if (mode.localMode) enterLocalMode();
        else readHostedSession();
      })
      .catch(() => {
        // An unreachable /api/mode leaves the mode unknown; behave like the
        // hosted client (ordinary session read) rather than silently entering.
        if (!cancelled) readHostedSession();
      });

    return () => {
      cancelled = true;
    };
  }, [reconcileUser]);

  const handleAuthenticated = useCallback(async (nextUser: User) => {
    setLoading(true);
    setError(null);
    try {
      await reconcileUser(nextUser);
    } catch (err) {
      setError(localizeApiError(err, "auth.readProfileFailed"));
    } finally {
      setLoading(false);
    }
  }, [reconcileUser]);

  // Listen for 401 responses from any API call — session expired mid-use.
  useEffect(() => {
    const handler = () => handleSignOut();
    window.addEventListener("novel-vibe:unauthorized", handler);
    return () => window.removeEventListener("novel-vibe:unauthorized", handler);
  }, [handleSignOut]);

  function renderContent() {
    if (loading) {
      return (
        <main className="loading-screen">
          <div className="loading-mark" />
        </main>
      );
    }

    if (!user && location.pathname.startsWith("/community")) {
      return (
        <Routes>
          <Route path="/community" element={<CommunityPage onSignedOut={handleSignOut} user={null} />} />
          <Route path="/community/my-feedback" element={<MyFeedbackPage onSignedOut={handleSignOut} user={null} />} />
          <Route path="/community/write" element={<ArticleEditorPage onSignedOut={handleSignOut} user={null} />} />
          <Route path="/community/edit/:articleId" element={<ArticleEditorPage onSignedOut={handleSignOut} user={null} />} />
          <Route path="/community/author/:userId" element={<AuthorProfilePage onSignedOut={handleSignOut} user={null} />} />
          <Route path="/community/:articleId" element={<ArticleDetailPage onSignedOut={handleSignOut} user={null} />} />
          <Route path="*" element={<Navigate replace to="/community" />} />
        </Routes>
      );
    }

    if (!user) {
      return <LoginView initialError={error} onAuthenticated={handleAuthenticated} />;
    }

    return <>
      <AuthenticatedApp user={user} onSignedOut={handleSignOut} />
      {/* Invitations and rewards are a hosted-service feature; a local install has no inviter. */}
      {localMode ? null : <ReferralCampaignNotice userId={user.id} />}
    </>;
  }

  return <LocalModeProvider value={localMode}>{renderContent()}</LocalModeProvider>;
}
