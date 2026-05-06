import './App.css';
import { Routes, Route, Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../backend/supabaseClient";
import { useAuth } from "./AuthContext";
import LoginPage from "./pages/LoginPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import CreditsPage from "./pages/CreditsPage";
import FeedPage from './pages/FeedPage';
import MapPage from "./pages/MapPage";
import MessagePage from "./pages/MessagePage";
import SettingsPage from "./pages/SettingsPage";
import DashboardPage from "./pages/DashboardPage";
import DashboardOverviewPage from "./pages/dashboard/DashboardOverviewPage";
import ReportsPage from "./pages/dashboard/ReportsPage";
import FeedbackPage from "./pages/dashboard/FeedbackPage";
import BugsPage from "./pages/dashboard/BugsPage";
import SupportPage from "./pages/dashboard/SupportPage";
import MyWorkPage from "./pages/dashboard/MyWorkPage";
import StatsPage from "./pages/dashboard/StatsPage";
import FinancesPage from "./pages/dashboard/FinancesPage";
import NotFoundPage from "./pages/NotFoundPage";
import PrivacyPage from "./pages/PrivacyPage";
import NoteCard from "./components/NoteCard";
import DemoDisclaimerModal from "./components/DemoDisclaimerModal";
import { useDemo } from "./contexts/DemoContext";
import {
  DEMO_PROFILE, DEMO_LISTINGS, DEMO_CONVERSATIONS,
  DEMO_PROFILES, DEMO_LISTINGS_MAP, DEMO_UNREAD_COUNTS,
} from "./demo/mockData";
import AppFooter from "./components/AppFooter";
import ReferralPollModal from "./components/ReferralPollModal";
import PasskeySetupModal from "./components/PasskeySetupModal";
import { Capacitor } from "@capacitor/core";
import { App as CapApp } from "@capacitor/app";
import { dismissKeyboard } from "./utils/keyboard";
import { AppBar, Toolbar, Button, IconButton, Typography, Container, Box, Paper, Badge, Chip, Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, CircularProgress, TextField } from '@mui/material';
import { BiometricAuth } from "@aparajita/capacitor-biometric-auth";
import { Preferences } from "@capacitor/preferences";
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import HomeIcon from '@mui/icons-material/Home';
import FeedIcon from "@mui/icons-material/DynamicFeed";
import MapIcon from '@mui/icons-material/Map';
import SettingsIcon from '@mui/icons-material/Settings';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import BrightnessAutoIcon from '@mui/icons-material/BrightnessAuto';
import LogoutIcon from '@mui/icons-material/Logout';
import MessageIcon from '@mui/icons-material/Message';
import EmojiEventsIcon from '@mui/icons-material/EmojiEvents';
import SupervisorAccountIcon from '@mui/icons-material/SupervisorAccount';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { DEFAULT_TIME_ZONE, formatCalendarDate, resolveTimeZone } from './utils/timezone';
import apiFetch from './utils/apiFetch';
import { prefetchDashboard, clearDashboardCache } from './utils/dashboardPrefetch';
import usePushNotifications from './hooks/usePushNotifications';
import LeaderboardSidebar from './components/LeaderboardSidebar';

const LOADER_MESSAGES = [
  "Sniffing for lost items...",
  "Chasing squirrels...",
  "Fetching your data...",
  "Wagging tail...",
  "Digging up listings...",
  "Following the scent...",
  "Nose to the ground...",
  "Running in circles...",
  "Almost home!",
];

function LogoSpinner({ accent }) {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setIdx((i) => (i + 1) % LOADER_MESSAGES.length), 2000);
    return () => clearInterval(id);
  }, []);
  return (
    <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
      <Box sx={{ position: "relative", width: 340, height: 340, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Box component="svg" width="340" height="340" viewBox="0 0 340 340"
          sx={{ position: "absolute", top: 0, left: 0, animation: "spinLogo 1.4s linear infinite", transformOrigin: "170px 170px",
            "@keyframes spinLogo": { to: { transform: "rotate(360deg)" } } }}>
          <circle cx="170" cy="170" r="168" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="2" />
          <circle cx="170" cy="170" r="168" fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeDasharray="791 264" />
        </Box>
        <Box component="img" src="/TabLogo.png" alt="Lost & Hound" sx={{ width: 230, height: 230, objectFit: "contain", position: "relative", zIndex: 1 }} />
      </Box>
      <Typography
        key={idx}
        sx={{
          fontSize: 18, fontWeight: 800, color: accent, opacity: 0.9,
          animation: "fadeInMsg 0.3s ease",
          "@keyframes fadeInMsg": {
            from: { opacity: 0, transform: "translateY(4px)" },
            to: { opacity: 0.9, transform: "translateY(0)" },
          },
        }}
      >
        {LOADER_MESSAGES[idx]}
      </Typography>
    </Box>
  );
}

export default function App() {
  const { user, profile, sessionToken, logout, updateProfile, isPasswordRecovery, setIsPasswordRecovery } = useAuth();
  const { isDemoMode, exitDemo } = useDemo();
  usePushNotifications(user?.id);
  const navigate = useNavigate();
  const [demoDismissed, setDemoDismissed] = useState(false);

  // Drain any referral source that was saved at signup (unauthenticated flow)
  // so the poll modal is suppressed on first login without re-asking the user
  const [referralPending, setReferralPending] = useState(() => !!localStorage.getItem("pending_referral_source"));
  useEffect(() => {
    if (!user || !profile || !referralPending) return;
    const source = localStorage.getItem("pending_referral_source");
    localStorage.removeItem("pending_referral_source");
    if (!source) { setReferralPending(false); return; }
    apiFetch("/api/referral/user", { method: "POST", body: JSON.stringify({ source }) })
      .then(() => updateProfile({ referral_answered: true }))
      .catch(() => {})
      .finally(() => setReferralPending(false));
  }, [user?.id, !!profile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show passkey setup prompt after first password login on web (once per device/user)
  useEffect(() => {
    if (!user || !profile || Capacitor.isNativePlatform() || !justLoggedIn.current) return;
    if (localStorage.getItem(`passkey_prompted_${user.id}`)) return;
    if (localStorage.getItem("passkey_email")) return; // already has a passkey
    // Small delay so the login transition finishes before the modal appears
    const t = setTimeout(() => setPasskeyModalOpen(true), 1500);
    return () => clearTimeout(t);
  }, [user?.id, !!profile]); // eslint-disable-line react-hooks/exhaustive-deps

  const demoDisclaimerOpen = isDemoMode && !demoDismissed;

  useEffect(() => {
    if (!isDemoMode) setDemoDismissed(false);
  }, [isDemoMode]);
  const location = useLocation();
  const darkBg = "#101214";
  const isCompactNav = useMediaQuery("(max-width:1100px)");
  const leaderboardRef = useRef();

  // Scroll to top on route change
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  // Background prefetch — fire as soon as we know user is a moderator
  useEffect(() => {
    if (profile?.is_moderator) {
      prefetchDashboard();
    }
  }, [profile?.is_moderator]);

  const handleLogout = useCallback(async () => {
    clearDashboardCache();
    await logout();
    navigate("/");
  }, [logout, navigate]);

  const handleExitDemo = useCallback(() => {
    exitDemo();
    navigate("/");
  }, [exitDemo, navigate]);

  const [themeMode, setThemeMode] = useState(() => {
    const saved = localStorage.getItem("themeMode");
    return saved === "light" || saved === "dark" || saved === "auto" ? saved : "auto";
  });
  const [timeZone, setTimeZone] = useState(() =>
    resolveTimeZone(localStorage.getItem("timeZone") || DEFAULT_TIME_ZONE)
  );
  const [systemPrefersDark, setSystemPrefersDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  // Conversations state — lifted here so data persists across page navigations
  const [msgConversations, setMsgConversations] = useState([]);
  const [msgProfiles, setMsgProfiles] = useState({});
  const [msgListings, setMsgListings] = useState({});
  const [msgUnreadCounts, setMsgUnreadCounts] = useState({});
  const [msgConversationsLoaded, setMsgConversationsLoaded] = useState(false);

  const fetchConversations = useCallback(async () => {
    try {
      const result = await apiFetch("/api/conversations");
      setMsgConversations(result?.conversations || []);
      setMsgProfiles(result?.profiles || {});
      setMsgListings(result?.listings || {});
      setMsgUnreadCounts(result?.unreadCounts || {});
    } catch (err) {
      console.error("Fetch conversations error:", err);
    }
    setMsgConversationsLoaded(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isDemoMode) {
      setMsgConversations(DEMO_CONVERSATIONS);
      setMsgProfiles(DEMO_PROFILES);
      setMsgListings(DEMO_LISTINGS_MAP);
      setMsgUnreadCounts(DEMO_UNREAD_COUNTS);
      setMsgConversationsLoaded(true);
      return;
    }
    if (!user || !sessionToken) {
      setMsgConversations([]);
      setMsgProfiles({});
      setMsgListings({});
      setMsgUnreadCounts({});
      setMsgConversationsLoaded(false);
      return;
    }
    fetchConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps

    // Live update: refresh conversation list when new messages, conversations, or blocks change
    const convoChannel = supabase
      .channel("convo-list-web")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, fetchConversations)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "conversations" }, fetchConversations)
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "conversations" }, fetchConversations)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "blocked_users", filter: `blocker_id=eq.${user.id}` }, fetchConversations)
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "blocked_users", filter: `blocker_id=eq.${user.id}` }, fetchConversations)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "blocked_users", filter: `blocked_id=eq.${user.id}` }, fetchConversations)
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "blocked_users", filter: `blocked_id=eq.${user.id}` }, fetchConversations)
      .subscribe();

    return () => { supabase.removeChannel(convoChannel); };
  }, [user?.id, sessionToken, isDemoMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shared listings state — fetched once, used by Feed and Map pages
  const [sharedItems, setSharedItems] = useState([]);
  const [sharedItemsLoaded, setSharedItemsLoaded] = useState(false);

  const fetchAllItems = useCallback(async () => {
    if (isDemoMode) return;
    try {
      await apiFetch("/api/listings/cleanup", { method: "POST" }).catch(() => {});
      let allItems = [];
      let page = 1;
      let hasMore = true;
      while (hasMore) {
        const result = await apiFetch(`/api/listings?page=${page}&limit=100`);
        allItems = [...allItems, ...(result?.data || [])];
        hasMore = result?.hasMore ?? false;
        page++;
      }
      setSharedItems(allItems);
    } catch (err) {
      console.error("Fetch listings error:", err);
    }
    setSharedItemsLoaded(true);
  }, [isDemoMode]);

  useEffect(() => {
    if (isDemoMode) {
      setSharedItems(DEMO_LISTINGS);
      setSharedItemsLoaded(true);
      return;
    }
    if (!user || !sessionToken) {
      setSharedItems([]);
      setSharedItemsLoaded(false);
      return;
    }
    fetchAllItems();
  }, [user?.id, sessionToken, fetchAllItems, isDemoMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Unread message count — shown as a badge on the Messages nav button
  const [unreadCount, setUnreadCount] = useState(0);
  useEffect(() => {
    if (isDemoMode) { setUnreadCount(0); return; }
    if (!user || !sessionToken) { setUnreadCount(0); return; }

    // Fetch the current unread count from the backend
    const fetchUnread = () =>
      apiFetch("/api/messages/unread-count")
        .then(d => setUnreadCount(d.count ?? 0))
        .catch(() => {});

    fetchUnread();

    // Subscribe to new message inserts so the badge updates in real time
    // without the user needing to refresh the page
    const channel = supabase
      .channel("unread-badge")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, fetchUnread)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, fetchUnread)
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, fetchUnread)
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "conversations" }, fetchUnread)
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user?.id, sessionToken]);

  // Handle email link verification (password recovery, etc.)
  // The email links directly to our app with token_hash & type params,
  // bypassing Supabase's /auth/v1/verify endpoint so Microsoft SafeLinks
  // can't consume the token by pre-fetching it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tokenHash = params.get("token_hash");
    const type = params.get("type");
    const code = params.get("code");

    if (tokenHash && type) {
      supabase.auth.verifyOtp({ token_hash: tokenHash, type }).then(({ error }) => {
        if (error) console.error("Token verification failed:", error.message);
        window.history.replaceState({}, "", window.location.pathname);
      });
    } else if (code) {
      supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
        if (error) console.error("Code exchange failed:", error.message);
        window.history.replaceState({}, "", window.location.pathname);
      });
    }
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e) => setSystemPrefersDark(e.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    localStorage.setItem("themeMode", themeMode);
  }, [themeMode]);

  useEffect(() => {
    localStorage.setItem("timeZone", timeZone);
  }, [timeZone]);

  const effectiveTheme = themeMode === "auto" ? (systemPrefersDark ? "dark" : "light") : themeMode;
  const effectiveProfile = isDemoMode ? DEMO_PROFILE : profile;
  const darkAccent = "#FF4500";
  const darkAccentHover = "#E03D00";
  const pageDot = effectiveTheme === "dark" ? "rgba(255,255,255,0.07)" : "rgba(122,41,41,0.18)";
  const pageBg = effectiveTheme === "dark" ? darkBg : "#f9f5f4";

  useEffect(() => {
    const bg = effectiveTheme === "dark" ? darkBg : "#f5f0f0";
    const dot = effectiveTheme === "dark" ? "rgba(255,255,255,0.07)" : "rgba(122,41,41,0.18)";
    document.documentElement.style.colorScheme = effectiveTheme;
    document.documentElement.style.backgroundColor = bg;
    document.body.style.backgroundColor = bg;
    document.body.style.backgroundImage = `radial-gradient(circle, ${dot} 1px, transparent 1px)`;
    document.body.style.backgroundSize = "24px 24px";
    document.body.style.backgroundAttachment = "fixed";
  }, [effectiveTheme]);

  const navBg = effectiveTheme === "dark" ? "#1A1A1B" : "#A84D48";
  const navBorder = effectiveTheme === "dark" ? "1px solid rgba(255,255,255,0.12)" : "none";

  const appTheme = useMemo(
    () =>
      createTheme({
        palette: {
          mode: effectiveTheme,
          primary: { main: effectiveTheme === "dark" ? darkAccent : "#A84D48" },
          background: {
            default: effectiveTheme === "dark" ? darkBg : "#f5f0f0",
            paper: effectiveTheme === "dark" ? "#1A1A1B" : "#ffffff",
          },
          text: {
            primary: effectiveTheme === "dark" ? "#D7DADC" : "#2d2d2d",
            secondary: effectiveTheme === "dark" ? "#818384" : "#6b6b6b",
          },
        },
        typography: {
          fontFamily: '"Nunito", "Roboto", "Helvetica", "Arial", sans-serif',
        },
        components: {
          MuiPaper: {
            styleOverrides: {
              root: {
                backgroundImage: "none",
              },
            },
          },
          MuiOutlinedInput: {
            styleOverrides: {
              root: {
                backgroundColor: effectiveTheme === "dark" ? "#2D2D2E" : "#fff",
              },
            },
          },
          MuiTextField: {
            defaultProps: {
              autoComplete: "off",
            },
          },
          MuiChip: {
            styleOverrides: {
              root: {
                backgroundColor: effectiveTheme === "dark" ? "#1A1A1B" : "#fff",
              },
            },
          },
          MuiButton: {
            styleOverrides: {
              root: ({ ownerState }) => ({
                textTransform: "none",
                ...(ownerState.variant === "outlined"
                  ? {
                      backgroundColor: effectiveTheme === "dark" ? "#1A1A1B" : "#fff",
                    }
                  : {}),
              }),
            },
          },
        },
      }),
    [effectiveTheme]
  );

  const toggleThemeFromNav = () => {
    if (themeMode === "auto") {
      return;
    }
    if (themeMode === "light") {
      setThemeMode("dark");
    } else {
      setThemeMode("light");
    }
  };

  const navThemeToggle =
    themeMode === "auto"
      ? {
          label: `Default (${effectiveTheme === "dark" ? "Dark" : "Light"})`,
          icon: <BrightnessAutoIcon />,
          disabled: true,
        }
      : themeMode === "light"
        ? { label: "Light", icon: <LightModeIcon />, disabled: false }
        : { label: "Dark", icon: <DarkModeIcon />, disabled: false };

  // LoginPage calls onLoginSuccess right before signing in.
  // This holds the LoginPage on screen for 1.8s so the animation can play.
  const [loginTransition, setLoginTransition] = useState(false);
  const [awaitingProfile, setAwaitingProfile] = useState(false);
  const didLoginTransition = useRef(false);
  // Tracks whether we're still waiting for the initial profile fetch on page refresh.
  // Starts true and flips to false once we get a result (success or failure).
  const [profileInitLoading, setProfileInitLoading] = useState(true);

  useEffect(() => {
    // Once we have a profile, or we know there's no user, initial load is done.
    // Also if user exists but profile is null (2FA_REQUIRED), we give it a short
    // window then stop showing the spinner so the MFA screen can appear.
    if (profile || !user) {
      setProfileInitLoading(false);
    } else if (user && !profile) {
      // User exists but no profile yet — could be loading or 2FA blocked.
      // Set a timeout so we don't spin forever if 2FA is required.
      const timer = setTimeout(() => setProfileInitLoading(false), 1500);
      return () => clearTimeout(timer);
    }
  }, [profile, user]);

  const justLoggedIn = useRef(false);
  const [passkeyModalOpen, setPasskeyModalOpen] = useState(false);

  const onLoginSuccess = useCallback(() => {
    justLoggedIn.current = true;
    setLoginTransition(true);
    setAwaitingProfile(true);
    didLoginTransition.current = true;
    setTimeout(() => setLoginTransition(false), 1200);
  }, []);

  const onLoginCancel = useCallback(() => {
    setLoginTransition(false);
    setAwaitingProfile(false);
  }, []);

  // ── App lock ──────────────────────────────────────────────
  const LOCK_GRACE_MS = 15000;
  const backgroundedAt = useRef(null);
  const coldStartChecked = useRef(false);
  const [appLocked, setAppLocked] = useState(false);
  const [lockLoading, setLockLoading] = useState(false);
  const [lockPassword, setLockPassword] = useState("");
  const [lockError, setLockError] = useState("");
  const [showPasswordFallback, setShowPasswordFallback] = useState(false);

  const faceIdEnrolled = !!localStorage.getItem("biometric_email");

  const lockApp = useCallback(() => {
    setAppLocked(true);
    setLockPassword("");
    setLockError("");
    setShowPasswordFallback(false);
  }, []);

  const unlockWithFaceId = useCallback(async () => {
    setLockLoading(true);
    setLockError("");
    try {
      await BiometricAuth.authenticate({ reason: "Unlock Lost & Hound" });
      setAppLocked(false);
    } catch (err) {
      const msg = err?.message || "";
      if (!msg.toLowerCase().includes("cancel")) {
        setLockError("Face ID failed.");
        setShowPasswordFallback(true);
      }
    } finally {
      setLockLoading(false);
    }
  }, []);

  const unlockWithPassword = useCallback(async () => {
    if (!lockPassword) return;
    setLockLoading(true);
    setLockError("");
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: user?.email, password: lockPassword });
      if (error) throw error;
      setAppLocked(false);
      setLockPassword("");
    } catch {
      setLockError("Incorrect password.");
    } finally {
      setLockLoading(false);
    }
  }, [lockPassword, user?.email]);

  // Cold start: lock when existing session is restored (not after a fresh login)
  useEffect(() => {
    if (!user || !profile) { coldStartChecked.current = false; return; }
    if (coldStartChecked.current) return;
    coldStartChecked.current = true;
    if (!Capacitor.isNativePlatform()) return;
    if (justLoggedIn.current) { justLoggedIn.current = false; return; }
    lockApp();
  }, [user, profile, lockApp]);

  // Resume from background: lock after grace period
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const sub = CapApp.addListener("appStateChange", ({ isActive }) => {
      if (!isActive) {
        backgroundedAt.current = Date.now();
      } else if (user && profile) {
        const elapsed = backgroundedAt.current ? Date.now() - backgroundedAt.current : Infinity;
        if (elapsed > LOCK_GRACE_MS) lockApp();
      }
    });
    return () => { sub.then(h => h.remove()); };
  }, [user, profile, lockApp]);

  // Auto-trigger Face ID when lock screen appears
  useEffect(() => {
    if (!appLocked || !Capacitor.isNativePlatform() || !faceIdEnrolled) return;
    const t = setTimeout(() => unlockWithFaceId(), 300);
    return () => clearTimeout(t);
  }, [appLocked]); // eslint-disable-line react-hooks/exhaustive-deps

  const [faceIdEnrollOpen, setFaceIdEnrollOpen] = useState(false);
  const [faceIdEnrolling, setFaceIdEnrolling] = useState(false);

  useEffect(() => {
    if (!user || !profile) return;
    if (!Capacitor.isNativePlatform()) return;
    Preferences.get({ key: "__bio_enroll_pending" }).then(({ value }) => {
      if (value) setFaceIdEnrollOpen(true);
    });
  }, [user, profile]);

  const handleFaceIdEnrollConfirm = async () => {
    setFaceIdEnrolling(true);
    const { value: pendingPass } = await Preferences.get({ key: "__bio_enroll_pending" });
    try {
      await BiometricAuth.authenticate({ reason: "Enable Face ID sign-in for Lost & Hound" });
      await Preferences.set({ key: "__bio_credential", value: pendingPass });
      localStorage.setItem("biometric_email", user?.email || "");
    } catch {
      // cancelled or failed — just skip enrollment
    } finally {
      await Preferences.remove({ key: "__bio_enroll_pending" });
      localStorage.setItem("face_id_prompted", "1");
      setFaceIdEnrollOpen(false);
      setFaceIdEnrolling(false);
    }
  };

  const handleFaceIdEnrollSkip = async () => {
    await Preferences.remove({ key: "__bio_enroll_pending" });
    localStorage.setItem("face_id_prompted", "1");
    setFaceIdEnrollOpen(false);
  };

  useEffect(() => {
    if (profile || !user) {
      setAwaitingProfile(false);
    }
  }, [profile, user]);

  // Password recovery: Supabase gives a valid session via the email link,
  // so intercept before the normal auth check to show the reset form.
  if (isPasswordRecovery) {
    // `user` is only set after verifyOtp resolves and PASSWORD_RECOVERY fires.
    // Showing the form before that means the session doesn't exist yet, so any
    // submit attempt gets 401 "Invalid token" from requireAuth.
    // Wait for the session to be ready; time out after 8 s if something went wrong.
    const sessionReady = !!user;
    return (
      <ThemeProvider theme={appTheme}>
        <CssBaseline />
        {!sessionReady ? (
          <Box
            sx={{
              minHeight: "100dvh",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: effectiveTheme === "dark" ? darkBg : "#f5f0f0",
              backgroundImage: `radial-gradient(circle, ${pageDot} 1px, transparent 1px)`,
              backgroundSize: "24px 24px",
            }}
          >
            <LogoSpinner accent={effectiveTheme === "dark" ? darkAccent : "#A84D48"} />
          </Box>
        ) : (
          <ResetPasswordPage
            effectiveTheme={effectiveTheme}
            onComplete={async () => {
              setIsPasswordRecovery(false);
              await supabase.auth.signOut();
              window.location.href = "/";
            }}
          />
        )}
      </ThemeProvider>
    );
  }

  // Keep showing LoginPage while auth/MFA is in progress.
  // This avoids a blank screen if /api/profile is blocked by require2FA.
  if (!isDemoMode && (!user || loginTransition || !profile)) {
    return (
      <ThemeProvider theme={appTheme}>
        <CssBaseline />
        {(awaitingProfile || profileInitLoading) && !loginTransition ? (
          <Box
            sx={{
              minHeight: '100dvh',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: effectiveTheme === "dark" ? darkBg : "#f5f0f0",
              backgroundImage: `radial-gradient(circle, ${pageDot} 1px, transparent 1px)`,
              backgroundSize: "24px 24px",
            }}
          >
            <LogoSpinner accent={effectiveTheme === "dark" ? darkAccent : "#A84D48"} />
          </Box>
        ) : (
          <Routes>
            <Route
              path="/privacy"
              element={<PrivacyPage effectiveTheme={effectiveTheme} />}
            />
            <Route
              path="/credits"
              element={<CreditsPage effectiveTheme={effectiveTheme} />}
            />
            <Route
              path="/forgot-password"
              element={<ForgotPasswordPage effectiveTheme={effectiveTheme} />}
            />
            <Route
              path="/reset-password"
              element={<ResetPasswordPage effectiveTheme={effectiveTheme} />}
            />
            <Route
              path="*"
              element={
                <LoginPage
                  loginTransition={loginTransition}
                  onLoginSuccess={onLoginSuccess}
                  onLoginCancel={onLoginCancel}
                  effectiveTheme={effectiveTheme}
                />
              }
            />
          </Routes>
        )}
      </ThemeProvider>
    );
  }

  // Ban check
  if (!isDemoMode && profile?.banned_until) {
    const bannedUntil = new Date(profile.banned_until);
    if (bannedUntil > new Date()) {
      const isPermanent = bannedUntil.getFullYear() === 9999;
      return (
        <ThemeProvider theme={appTheme}>
          <CssBaseline />
        <>
          <AppBar position="fixed" sx={{ background: navBg, borderBottom: navBorder, pt: "env(safe-area-inset-top)" }}>
            <Toolbar
              sx={{
                gap: { xs: 0.5, sm: 1 },
                px: { xs: 1, sm: 2 },
                overflowX: "auto",
                "&::-webkit-scrollbar": { display: "none" },
              }}
            >
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Box component="img" src="/TabLogo.png" alt="Lost & Hound logo"
                  sx={{ height: 48, width: 48, objectFit: "contain" }} />
                <Typography variant="h6" fontWeight={900} sx={{ letterSpacing: 0.5, display: { xs: "none", sm: "block" } }}>
                  Lost &amp; Hound
                </Typography>
              </Box>
              <Box sx={{ flexGrow: 1 }} />
              {isCompactNav ? (
                <IconButton color="inherit" onClick={toggleThemeFromNav} disabled={navThemeToggle.disabled} sx={{ mr: 0.5 }}>{navThemeToggle.icon}</IconButton>
              ) : (
                <Button color="inherit" onClick={toggleThemeFromNav} startIcon={navThemeToggle.icon} disabled={navThemeToggle.disabled} sx={{ mr: 1, minWidth: 0 }}>{navThemeToggle.label}</Button>
              )}
              {isCompactNav ? (
                <IconButton color="inherit" onClick={handleLogout}><LogoutIcon /></IconButton>
              ) : (
                <Button color="inherit" onClick={handleLogout} endIcon={<LogoutIcon />} sx={{ minWidth: 0 }}>Log Out</Button>
              )}
            </Toolbar>
          </AppBar>
          <Box sx={{ height: "calc(64px + env(safe-area-inset-top))" }} />
          <Box
            sx={{
              position: "fixed",
              inset: 0,
              zIndex: -1,
              backgroundColor: pageBg,
              backgroundImage: `radial-gradient(circle, ${pageDot} 1px, transparent 1px)`,
              backgroundSize: "24px 24px",
            }}
          />
          <Box sx={{
            display: "flex", justifyContent: "center", alignItems: "center",
            height: "calc(100dvh - 64px - env(safe-area-inset-top) - 56px - env(safe-area-inset-bottom))",
            p: 3,
            boxSizing: "border-box",
          }}>
              <Paper elevation={0} sx={{
                p: 4, pt: 0, borderRadius: 3, textAlign: "center", maxWidth: 380,
                border: effectiveTheme === "dark" ? "1px solid rgba(255,255,255,0.14)" : "1.5px solid #ecdcdc",
                overflow: "visible",
                boxShadow:
                  effectiveTheme === "dark"
                    ? "0 10px 36px rgba(0,0,0,0.45), 0 2px 10px rgba(0,0,0,0.3)"
                    : "0 8px 32px rgba(168, 77, 72, 0.13), 0 2px 8px rgba(0,0,0,0.07)",
                background: effectiveTheme === "dark" ? "#1A1A1B" : "#fff",
              }}>
              <Box component="img" src="/HuskyBan.png" alt="Banned husky"
                sx={{ width: "100%", maxWidth: 260, mx: "auto", display: "block", mt: -6, mb: -2 }} />
              <Typography variant="h3" fontWeight={900} sx={{ mb: 0.5, color: effectiveTheme === "dark" ? "#D7DADC" : "#3d2020" }}>
                Account Suspended
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                {isPermanent
                  ? "Your account has been permanently suspended."
                  : `Your account is suspended until ${formatCalendarDate(bannedUntil, timeZone)}.`}
              </Typography>
              {profile.ban_reason && (
                <Typography variant="body2" sx={{ mb: 2, color: effectiveTheme === "dark" ? "#FF6A33" : "#A84D48", fontWeight: 600 }}>
                  {profile.ban_reason}
                </Typography>
              )}
              <Button variant="contained" onClick={handleLogout}
                sx={{ background: effectiveTheme === "dark" ? darkAccent : "#A84D48", "&:hover": { background: effectiveTheme === "dark" ? darkAccentHover : "#8f3e3a" }, fontWeight: 700, borderRadius: 2, px: 4 }}>
                LOG OUT
              </Button>
            </Paper>
          </Box>
          <AppFooter effectiveTheme={effectiveTheme} />
        </>
        </ThemeProvider>
      );
    }
  }

  // Check if we should fade in (came from login animation)
  const shouldFadeIn = didLoginTransition.current;
  // Reset the ref so refreshes / normal navigation don't fade
  didLoginTransition.current = false;

  return (
    <ThemeProvider theme={appTheme}>
      <CssBaseline />
    <>
    <AppBar position="fixed" sx={{ background: navBg, borderBottom: navBorder, pt: "env(safe-area-inset-top)" }}>
        <Toolbar
          sx={{
            gap: { xs: 0.5, sm: 1 },
            px: { xs: 1, sm: 2 },
            overflowX: "auto",
            "&::-webkit-scrollbar": { display: "none" },
          }}
        >
          <Box
            component={Link}
            to="/"
            sx={{ display: "flex", alignItems: "center", gap: 1, mr: { xs: 1, sm: 2 }, textDecoration: "none", color: "inherit", flexShrink: 0 }}
          >
            <Box
              component="img"
              src="/TabLogo.png"
              alt="Lost & Hound logo"
              sx={{ height: 48, width: 48, objectFit: "contain"}}
            />
            <Typography variant="h6" fontWeight={900} sx={{ letterSpacing: 0.5, display: { xs: "none", sm: "block" } }}>
              Lost &amp; Hound
            </Typography>
            {isDemoMode && (
              <Chip
                label="DEMO"
                size="small"
                sx={{
                  background: "rgba(255,255,255,0.22)",
                  color: "#fff",
                  fontWeight: 800,
                  fontSize: 10,
                  letterSpacing: 1,
                  height: 20,
                  border: "1px solid rgba(255,255,255,0.4)",
                }}
              />
            )}
          </Box>
          {isCompactNav ? (
            <IconButton color="inherit" component={Link} to="/" sx={{ mr: 0.5 }}><FeedIcon /></IconButton>
          ) : (
            <Button color="inherit" component={Link} to="/" startIcon={<FeedIcon />} sx={{ mr: 1, minWidth: 0 }}>Feed</Button>
          )}
          {isCompactNav ? (
            <IconButton color="inherit" component={Link} to="/map" sx={{ mr: 0.5 }}><MapIcon /></IconButton>
          ) : (
            <Button color="inherit" component={Link} to="/map" startIcon={<MapIcon />} sx={{ mr: 1, minWidth: 0 }}>Map</Button>
          )}
          {isCompactNav ? (
            <IconButton color="inherit" component={Link} to="/messages">
              <Badge badgeContent={unreadCount} color="error" max={99}><MessageIcon /></Badge>
            </IconButton>
          ) : (
            <Button color="inherit" component={Link} to="/messages" startIcon={<Badge badgeContent={unreadCount} color="error" max={99}><MessageIcon /></Badge>} sx={{ minWidth: 0 }}>Messages</Button>
          )}
          <IconButton
            color="inherit"
            onClick={() => leaderboardRef.current?.openModal()}
            sx={{ display: { xs: "inline-flex", lg: "none" }, mr: 0.5 }}
          >
            <EmojiEventsIcon />
          </IconButton>
          <Box sx={{ flexGrow: 1 }} />
          {!isDemoMode && !Capacitor.isNativePlatform() && effectiveProfile?.is_moderator && (
            <Button
              color="inherit"
              component={Link}
              to="/moderation"
              sx={{ minWidth: 0, mr: 0.5 }}
            >
              <SupervisorAccountIcon />
            </Button>
          )}
          <Typography variant="body1" sx={{ mr: 1, display: { xs: "none", md: "block" } }}>
            {effectiveProfile?.first_name && effectiveProfile?.last_name
              ? effectiveProfile.first_name + " " + effectiveProfile.last_name
              : user?.email ?? "Demo User"}
          </Typography>
          {isCompactNav ? (
            <IconButton color="inherit" onClick={toggleThemeFromNav} disabled={navThemeToggle.disabled} sx={{ mr: 0.5 }}>{navThemeToggle.icon}</IconButton>
          ) : (
            <Button color="inherit" onClick={toggleThemeFromNav} startIcon={navThemeToggle.icon} disabled={navThemeToggle.disabled} sx={{ mr: 1, minWidth: 0 }}>{navThemeToggle.label}</Button>
          )}
          {isCompactNav ? (
            <IconButton color="inherit" component={Link} to="/settings" sx={{ mr: 0.5 }}><SettingsIcon /></IconButton>
          ) : (
            <Button color="inherit" component={Link} to="/settings" endIcon={<SettingsIcon />} sx={{ mr: 1, minWidth: 0 }}>Settings</Button>
          )}
          {isDemoMode ? (
            isCompactNav ? (
              <IconButton color="inherit" onClick={handleExitDemo}><LogoutIcon /></IconButton>
            ) : (
              <Button color="inherit" onClick={handleExitDemo} endIcon={<LogoutIcon />} sx={{ minWidth: 0 }}>Exit Demo</Button>
            )
          ) : (
            isCompactNav ? (
              <IconButton color="inherit" onClick={handleLogout}><LogoutIcon /></IconButton>
            ) : (
              <Button color="inherit" onClick={handleLogout} endIcon={<LogoutIcon />} sx={{ minWidth: 0 }}>Log Out</Button>
            )
          )}
        </Toolbar>
      </AppBar>
      {/* Spacer matches AppBar height including safe-area-inset-top */}
      <Box sx={{ height: "calc(64px + env(safe-area-inset-top))" }} />
      <Box
        sx={{
          ...(shouldFadeIn
            ? {
                animation: "appFadeIn 0.8s cubic-bezier(0.4, 0, 0.2, 1) 0.15s both",
                "@keyframes appFadeIn": {
                  "0%": { opacity: 0, transform: "translateY(6px)" },
                  "100%": { opacity: 1, transform: "translateY(0)" },
                },
              }
            : {}),
        }}
      >
        <Box sx={{ mt: 0, pb: { xs: "calc(78px + env(safe-area-inset-bottom))", sm: "calc(64px + env(safe-area-inset-bottom))" } }}>
          <Routes>
            <Route path="/" element={<FeedPage effectiveTheme={effectiveTheme} timeZone={timeZone} sharedItems={sharedItems} setSharedItems={setSharedItems} sharedItemsLoaded={sharedItemsLoaded} refreshItems={fetchAllItems} />} />
            <Route path="/map" element={<MapPage effectiveTheme={effectiveTheme} timeZone={timeZone} sharedItems={sharedItems} setSharedItems={setSharedItems} sharedItemsLoaded={sharedItemsLoaded} refreshItems={fetchAllItems} />} />
            <Route path="/messages" element={<MessagePage effectiveTheme={effectiveTheme} timeZone={timeZone} conversations={msgConversations} setConversations={setMsgConversations} profiles={msgProfiles} setProfiles={setMsgProfiles} listings={msgListings} setListings={setMsgListings} unreadCounts={msgUnreadCounts} setUnreadCounts={setMsgUnreadCounts} conversationsLoaded={msgConversationsLoaded} refreshConversations={fetchConversations} />} />
            <Route
              path="/settings"
              element={
                <SettingsPage
                  themeMode={themeMode}
                  setThemeMode={setThemeMode}
                  timeZone={timeZone}
                  setTimeZone={setTimeZone}
                  effectiveTheme={effectiveTheme}
                />
              }
            />
            {!isDemoMode && !Capacitor.isNativePlatform() && (
              <Route path="/moderation" element={<DashboardPage effectiveTheme={effectiveTheme} timeZone={timeZone} />}>
                <Route index element={<DashboardOverviewPage />} />
                <Route path="reports"  element={<ReportsPage />} />
                <Route path="stolen"   element={<ReportsPage isStolen />} />
                <Route path="feedback" element={<FeedbackPage />} />
                <Route path="bugs"     element={<BugsPage />} />
                <Route path="support"  element={<SupportPage />} />
                <Route path="my-work"  element={<MyWorkPage />} />
                <Route path="stats"    element={<StatsPage />} />
                {effectiveProfile?.is_owner && <Route path="finances" element={<FinancesPage />} />}
              </Route>
            )}
            <Route path="/credits" element={<CreditsPage effectiveTheme={effectiveTheme} />} />
            <Route path="/privacy" element={<PrivacyPage effectiveTheme={effectiveTheme} />} />
            <Route path="*" element={<NotFoundPage effectiveTheme={effectiveTheme} />} />
          </Routes>
        </Box>
      </Box>

      <AppFooter effectiveTheme={effectiveTheme} />

      <LeaderboardSidebar ref={leaderboardRef} effectiveTheme={effectiveTheme} modalOnly />

      <ReferralPollModal
        open={!isDemoMode && !!profile && !profile.referral_answered && !referralPending}
        isDark={effectiveTheme === "dark"}
        onDone={() => updateProfile({ referral_answered: true })}
      />

      <DemoDisclaimerModal
        open={demoDisclaimerOpen}
        onClose={() => setDemoDismissed(true)}
        isDark={effectiveTheme === "dark"}
      />

      <PasskeySetupModal
        open={passkeyModalOpen}
        isDark={effectiveTheme === "dark"}
        userId={user?.id}
        userEmail={user?.email}
        onDone={() => setPasskeyModalOpen(false)}
      />

      {isDemoMode && location.pathname === "/" && (
        <NoteCard
          storageKey="demo-feed"
          title="Browse the Feed"
          description="Scroll through lost and found listings from the Northeastern community. Click any card to see details and contact the poster."
        />
      )}
      {isDemoMode && location.pathname === "/map" && (
        <NoteCard
          storageKey="demo-map"
          title="Campus Map"
          description="See lost and found items plotted on the Northeastern campus map. Click any map pin to view listing details."
        />
      )}
      {isDemoMode && location.pathname === "/messages" && (
        <NoteCard
          storageKey="demo-messages"
          title="Direct Messages"
          description="Message other students directly to coordinate item pickups. Built-in safety reminders keep everyone safe."
        />
      )}
      {/* ── App lock screen ── */}
      {appLocked && (
        <Box
          sx={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            backgroundColor: effectiveTheme === "dark" ? "#030303" : "#f5f0f0",
            backgroundImage: `radial-gradient(circle, ${effectiveTheme === "dark" ? "rgba(255,255,255,0.07)" : "rgba(122,41,41,0.12)"} 1px, transparent 1px)`,
            backgroundSize: "24px 24px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            px: 3,
            pb: "env(safe-area-inset-bottom)",
            pt: "env(safe-area-inset-top)",
          }}
        >
          <Box
            component="img"
            src="/MainLogoTextAlt.png"
            alt="Lost & Hound"
            sx={{ width: 180, mb: 4, opacity: 0.9 }}
          />

          <Paper
            elevation={0}
            sx={{
              width: "100%",
              maxWidth: 340,
              p: 3,
              borderRadius: 3,
              background: effectiveTheme === "dark" ? "#1A1A1B" : "#fff",
              border: `1px solid ${effectiveTheme === "dark" ? "rgba(255,255,255,0.14)" : "#ecdcdc"}`,
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <Typography variant="h6" fontWeight={800} textAlign="center">
              Unlock Lost &amp; Hound
            </Typography>

            {faceIdEnrolled && !showPasswordFallback ? (
              <>
                <Button
                  fullWidth
                  variant="contained"
                  onClick={unlockWithFaceId}
                  disabled={lockLoading}
                  startIcon={lockLoading ? <CircularProgress size={18} color="inherit" /> : null}
                  sx={{
                    py: 1.25, fontWeight: 700, borderRadius: 2, fontSize: 15,
                    textTransform: "none",
                    background: effectiveTheme === "dark" ? "#FF4500" : "#A84D48",
                    "&:hover": { background: effectiveTheme === "dark" ? "#E03D00" : "#8f3e3a" },
                  }}
                >
                  {lockLoading ? "Unlocking…" : "Unlock with Face ID"}
                </Button>
                {lockError && (
                  <Typography variant="caption" color="error" textAlign="center">{lockError}</Typography>
                )}
                <Button
                  fullWidth variant="text" size="small"
                  onClick={() => setShowPasswordFallback(true)}
                  sx={{ color: "text.secondary", textTransform: "none", display: "block", textAlign: "center" }}
                >
                  Use password instead
                </Button>
              </>
            ) : (
              <>
                <TextField
                  autoFocus fullWidth size="small" type="password"
                  label="Password" value={lockPassword}
                  onChange={(e) => setLockPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && lockPassword) { unlockWithPassword(); dismissKeyboard(); } }}
                  sx={{ "& .MuiOutlinedInput-root": { fontSize: { xs: 16, md: 13 } } }}
                />
                {lockError && (
                  <Typography variant="caption" color="error" textAlign="center">{lockError}</Typography>
                )}
                <Button
                  fullWidth variant="contained" disabled={!lockPassword || lockLoading}
                  onClick={unlockWithPassword}
                  startIcon={lockLoading ? <CircularProgress size={18} color="inherit" /> : null}
                  sx={{
                    py: 1.25, fontWeight: 700, borderRadius: 2, fontSize: 15,
                    textTransform: "none",
                    background: effectiveTheme === "dark" ? "#FF4500" : "#A84D48",
                    "&:hover": { background: effectiveTheme === "dark" ? "#E03D00" : "#8f3e3a" },
                  }}
                >
                  {lockLoading ? "Unlocking…" : "Unlock"}
                </Button>
                {faceIdEnrolled && (
                  <Button
                    fullWidth variant="text" size="small"
                    onClick={() => { setShowPasswordFallback(false); unlockWithFaceId(); }}
                    sx={{ color: "text.secondary", textTransform: "none" }}
                  >
                    Try Face ID again
                  </Button>
                )}
              </>
            )}

            <Button
              fullWidth variant="text" size="small" onClick={handleLogout}
              sx={{ color: "error.main", textTransform: "none", fontWeight: 600 }}
            >
              Sign Out
            </Button>
          </Paper>
        </Box>
      )}

      {/* Face ID enrollment prompt — shown once after first trusted-device login */}
      <Dialog
        open={faceIdEnrollOpen}
        onClose={handleFaceIdEnrollSkip}
        maxWidth="xs"
        fullWidth
        PaperProps={{
          sx: {
            borderRadius: 3,
            px: 1,
            background: effectiveTheme === "dark" ? "#1A1A1B" : "#fff",
            border: `1px solid ${effectiveTheme === "dark" ? "rgba(255,255,255,0.14)" : "#ecdcdc"}`,
          },
        }}
      >
        <DialogTitle sx={{ fontWeight: 800, pt: 3 }}>
          Sign in faster with Face ID
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            Enable Face ID to sign in instantly next time — no typing required. You can turn this off in Settings.
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 3, flexDirection: "column", gap: 1.25 }}>
          <Button
            fullWidth
            variant="contained"
            onClick={handleFaceIdEnrollConfirm}
            disabled={faceIdEnrolling}
            startIcon={faceIdEnrolling ? <CircularProgress size={16} color="inherit" /> : null}
            sx={{
              py: 1.25,
              background: effectiveTheme === "dark" ? "#FF4500" : "#A84D48",
              "&:hover": { background: effectiveTheme === "dark" ? "#E03D00" : "#8f3e3a" },
              fontWeight: 700,
              borderRadius: 2,
              fontSize: 15,
              textTransform: "none",
            }}
          >
            {faceIdEnrolling ? "Setting up…" : "Enable Face ID"}
          </Button>
          <Button
            fullWidth
            variant="text"
            onClick={handleFaceIdEnrollSkip}
            sx={{ color: "text.secondary", textTransform: "none", fontWeight: 600 }}
          >
            Not now
          </Button>
        </DialogActions>
      </Dialog>

    </>
    </ThemeProvider>
  );
}