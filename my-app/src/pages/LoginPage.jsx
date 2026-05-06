import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { dismissKeyboardOnEnter } from "../utils/keyboard";
import { BiometricAuth } from "@aparajita/capacitor-biometric-auth";
import { Preferences } from "@capacitor/preferences";
import { startAuthentication } from "@simplewebauthn/browser";
import { useDemo } from "../contexts/DemoContext";
import ConfettiCanvas from "../components/ConfettiCanvas";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../backend/supabaseClient";
import {
  Paper,
  TextField,
  Button,
  Typography,
  Box,
  Alert,
  Link as MuiLink,
  Checkbox,
  FormControlLabel,
  CircularProgress,
  LinearProgress,
  IconButton,
  Tooltip,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import LockResetIcon from "@mui/icons-material/LockReset";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import ShieldOutlinedIcon from "@mui/icons-material/ShieldOutlined";
import AppleIcon from "@mui/icons-material/Apple";
import PeopleAltOutlinedIcon from "@mui/icons-material/PeopleAltOutlined";
import FaceIcon from "@mui/icons-material/Face";
import FingerprintIcon from "@mui/icons-material/Fingerprint";
import TermsModal from "../components/TermsModal";
import LoginSupportModal from "../components/LoginSupportModal";
import DemoModal from "../components/DemoModal";
import apiFetch, { API_BASE } from "../utils/apiFetch";
import { stripInvisible } from "../utils/profanityFilter";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import InputLabel from "@mui/material/InputLabel";
import FormControl from "@mui/material/FormControl";

const NAME_MAX_LENGTH = 25;
const PASSWORD_MAX_LENGTH = 32;

// Module-level cache — survives component unmount so counter is instant on return visits
let userCountCache = null;

// ConfettiCanvas is imported from src/components/ConfettiCanvas.jsx

/* ───────────────────────────────────────────
   Login page
   ─────────────────────────────────────────── */
export default function LoginPage({
  loginTransition = false,
  onLoginSuccess,
  onLoginCancel,
  effectiveTheme = "light",
}) {
  const isDark = effectiveTheme === "dark";
  const navigate = useNavigate();
  const { enterDemo } = useDemo();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  // 2FA state
  const [authStep, setAuthStep] = useState("credentials"); // "credentials" | "mfa"
  const [otpCode, setOtpCode] = useState("");
  const [rememberDevice, setRememberDevice] = useState(false);
  const [mfaFactorId, setMfaFactorId] = useState("");
  const [mfaChallengeId, setMfaChallengeId] = useState("");
  const [mfaQrCodeSvg, setMfaQrCodeSvg] = useState("");
  const [mfaUri, setMfaUri] = useState("");
  const [mfaLoading, setMfaLoading] = useState(false);
  const [mfaVerifying, setMfaVerifying] = useState(false);
  const [resendingEmail, setResendingEmail] = useState(false);
  const [resendMessage, setResendMessage] = useState("");

  // Terms modal state
  const [termsOpen, setTermsOpen] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);

  // Support modal state
  const [supportOpen, setSupportOpen] = useState(false);
  // Demo modal state
  const [demoOpen, setDemoOpen] = useState(false);
  const [demoLaunching, setDemoLaunching] = useState(false);

  const handleViewDemo = useCallback(() => {
    setDemoOpen(false);
    setDemoLaunching(true);
    setTimeout(() => {
      enterDemo();
      navigate("/");
    }, 900);
  }, [navigate, enterDemo]);

  // Referral source (sign-up only)
  const [referralSource, setReferralSource] = useState("");

  // Community counter — seed from cache so it's instant on re-visits
  const [displayCount, setDisplayCount] = useState(userCountCache ?? 0);
  const [targetCount, setTargetCount] = useState(userCountCache ?? 0);

  // Fetch user count once on mount — public endpoint, no auth needed
  useEffect(() => {
    fetch(`${API_BASE}/api/stats/user-count`)
      .then((r) => r.json())
      .then((d) => {
        const rounded = Math.floor((d.count || 0) / 10) * 10;
        userCountCache = rounded;
        setTargetCount(rounded);
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Animate displayCount up to targetCount in steps of 10
  useEffect(() => {
    if (targetCount <= displayCount) return;
    let current = displayCount;
    const id = setInterval(() => {
      current += 10;
      setDisplayCount(current);
      if (current >= targetCount) clearInterval(id);
    }, 50);
    return () => clearInterval(id);
  }, [targetCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refs to read Chrome's autofilled DOM values (Chrome bypasses onChange)
  const emailRef = useRef(null);
  const passwordRef = useRef(null);

  // Sync Chrome autofill into React state on mount.
  useEffect(() => {
    const sync = () => {
      const eInput = emailRef.current?.querySelector("input");
      const pInput = passwordRef.current?.querySelector("input");
      if (eInput?.value && !email) setEmail(eInput.value);
      if (pInput?.value && !password) setPassword(pInput.value);
    };
    const t1 = setTimeout(sync, 100);
    const t2 = setTimeout(sync, 500);
    const t3 = setTimeout(sync, 1000);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard slide-up: shift the whole page up on native iOS when keyboard opens so
  // email/password stay visible (KeyboardResize.None keeps the webview fixed-size)
  const isNative = useMemo(() => Capacitor.isNativePlatform(), []);
  const [keyboardH, setKeyboardH] = useState(0);

  useEffect(() => {
    if (!isNative) return;
    const showSub = Keyboard.addListener("keyboardWillShow", ({ keyboardHeight }) => setKeyboardH(keyboardHeight));
    const hideSub = Keyboard.addListener("keyboardWillHide", () => setKeyboardH(0));
    return () => { showSub.then((h) => h.remove()); hideSub.then((h) => h.remove()); };
  }, [isNative]);

  const [biometryAvailable, setBiometryAvailable] = useState(false);
  const [storedBiometricEmail, setStoredBiometricEmail] = useState(null);
  const [faceIdLoading, setFaceIdLoading] = useState(false);
  const [manualMode, setManualMode] = useState(false);

  // Web passkey (Windows Hello / Touch ID) — only on non-native platform
  const [passkeyEmail] = useState(() => !Capacitor.isNativePlatform() ? (localStorage.getItem("passkey_email") || null) : null);
  const [passkeyLoading, setPasskeyLoading] = useState(false);

  useEffect(() => {
    if (!isNative) return;
    BiometricAuth.checkBiometry()
      .then(({ isAvailable }) => {
        if (!isAvailable) return;
        const stored = localStorage.getItem("biometric_email");
        setBiometryAvailable(true);
        if (stored) setStoredBiometricEmail(stored);
      })
      .catch(() => {});
  }, [isNative]);

  const [fadeOut, setFadeOut] = useState(false);

  const BRAND = {
    accent: isDark ? "#FF4500" : "#A84D48",
    accentHover: isDark ? "#E03D00" : "#8f3e3a",
    bg: isDark ? "#030303" : "#f5f0f0",
    dot: isDark ? "rgba(255,255,255,0.12)" : "#c9a6a6",
    paper: isDark ? "#1A1A1B" : "#fff",
    border: isDark ? "rgba(255,255,255,0.14)" : "#ecdcdc",
    title: isDark ? "#D7DADC" : "#3d2020",
    inputBg: isDark ? "#2D2D2E" : "#fff",
    inputBorder: isDark ? "rgba(255,255,255,0.2)" : "#d8c8c8",
    inputBorderHover: isDark ? "rgba(255,255,255,0.35)" : "#caa8a8",
    inputText: isDark ? "#D7DADC" : "#2d2d2d",
    autofillBg: isDark ? "#3b312b" : "#fff8f7",
    leftPanelGradient: isDark
      ? "linear-gradient(160deg, #1f252b 0%, #141619 100%)"
      : "linear-gradient(160deg, #A84D48 0%, #7a2929 100%)",
    leftPanelBody: isDark ? "rgba(215,218,220,0.74)" : "rgba(255,255,255,0.7)",
    leftPanelCaption: isDark ? "rgba(215,218,220,0.45)" : "rgba(255,255,255,0.4)",
  };

  const autofillTextFieldSx = {
    "& .MuiOutlinedInput-root": {
      backgroundColor: BRAND.inputBg,
      color: BRAND.inputText,
      "& .MuiOutlinedInput-notchedOutline": {
        borderColor: BRAND.inputBorder,
      },
      "&:hover .MuiOutlinedInput-notchedOutline": {
        borderColor: BRAND.inputBorderHover,
      },
      "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
        borderColor: BRAND.accent,
        borderWidth: "1px",
      },
      "& input:-webkit-autofill": {
        WebkitBoxShadow: `0 0 0 1000px ${BRAND.autofillBg} inset`,
        WebkitTextFillColor: BRAND.inputText,
        caretColor: BRAND.inputText,
        borderRadius: "inherit",
      },
      "& input:-webkit-autofill:hover": {
        WebkitBoxShadow: `0 0 0 1000px ${BRAND.autofillBg} inset`,
      },
      "& input:-webkit-autofill:focus": {
        WebkitBoxShadow: `0 0 0 1000px ${BRAND.autofillBg} inset`,
      },
      "& input:-webkit-autofill:active": {
        WebkitBoxShadow: `0 0 0 1000px ${BRAND.autofillBg} inset`,
      },
    },
    "& .MuiInputLabel-root": {
      color: isDark ? "#A9AAAB" : "inherit",
    },
    "& .MuiInputLabel-root.Mui-focused": {
      color: BRAND.accent,
    },
  };

  useEffect(() => {
    if (loginTransition || demoLaunching) {
      const timer = setTimeout(() => setFadeOut(true), 200);
      return () => clearTimeout(timer);
    }
  }, [loginTransition, demoLaunching]);

  // Reset terms accepted when switching between sign-up and sign-in
  useEffect(() => {
    setTermsAccepted(false);
    setReferralSource("");
    setManualMode(false);
  }, [isSignUp]);

  const doSignUp = async () => {
    try {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            first_name: firstName.trim(),
            last_name: lastName.trim(),
          },
          emailRedirectTo: window.location.origin,
        },
      });

      if (signUpError) {
        setError(cleanErrorMessage(signUpError.message || signUpError.code || "Unknown error"));
        return;
      }

      if (data.user && data.user.identities && data.user.identities.length === 0) {
        setError("An account with this email already exists.");
        return;
      }

      setMessage("SIGNUP_SUCCESS");
      setFirstName("");
      setLastName("");
      // Fire-and-forget referral — log source anonymously; stash locally so
      // first authenticated load can mark referral_answered without re-showing the modal
      if (referralSource) {
        fetch(`${API_BASE}/api/referral`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: referralSource }),
        }).catch(() => {});
        localStorage.setItem("pending_referral_source", referralSource);
      }
    } catch (err) {
      setError(cleanErrorMessage(err.message || err.code));
    }
  };

  const handleResendConfirmation = async () => {
    if (!email) return;
    setResendingEmail(true);
    setResendMessage("");
    try {
      const { error: resendError } = await supabase.auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo: window.location.origin },
      });
      if (resendError) throw resendError;
      setResendMessage("Verification email resent! Check your inbox.");
    } catch (err) {
      setResendMessage("Failed to resend. Please try again.");
    } finally {
      setResendingEmail(false);
    }
  };

  const startMfaFlow = async (existingFactorsData = null) => {
    let factorsData = existingFactorsData;
    if (!factorsData) {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) throw error;
      factorsData = data;
    }

    const totpFactors =
      factorsData?.all?.filter((f) => f.factor_type === "totp") ||
      factorsData?.totp ||
      [];
    const verifiedFactor = totpFactors.find((f) => f.status === "verified") || null;

    if (verifiedFactor?.id) {
      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: verifiedFactor.id,
      });
      if (challengeError) throw challengeError;

      setMfaFactorId(verifiedFactor.id);
      setMfaChallengeId(challengeData.id);
      setMfaQrCodeSvg("");
      setMfaUri("");
      setOtpCode("");
      setAuthStep("mfa");
      setMessage("Open your authenticator app and enter the current 6-digit code.");
      return;
    }

    // If only unverified factors exist, remove them and create a fresh enrollment
    // so the user always gets a valid QR setup screen.
    for (const factor of totpFactors) {
      if (factor?.id) {
        await supabase.auth.mfa.unenroll({ factorId: factor.id }).catch(() => null);
      }
    }

    const { data: enrollData, error: enrollError } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      // Use a unique friendly name to avoid duplicate-name conflicts.
      friendlyName: `Lost & Hound ${new Date().toISOString().slice(0, 10)}`,
    });
    if (enrollError) throw enrollError;

    const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId: enrollData.id,
    });
    if (challengeError) throw challengeError;

    setMfaFactorId(enrollData.id);
    setMfaChallengeId(challengeData.id);
    setMfaQrCodeSvg(enrollData.totp?.qr_code || "");
    setMfaUri(enrollData.totp?.uri || "");
    setOtpCode("");
    setAuthStep("mfa");
    setMessage("Set up your authenticator app, then enter the 6-digit code to complete login.");
  };

  const doSignIn = async (emailArg, passArg) => {
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email: emailArg,
      password: passArg,
    });
    if (signInError) throw signInError;

    const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
    if (factorsError) throw factorsError;

    const hasVerifiedTotp =
      (factorsData?.all || []).some((f) => f.factor_type === "totp" && f.status === "verified") ||
      (factorsData?.totp || []).some((f) => f.status === "verified");

    if (!hasVerifiedTotp) {
      setMfaLoading(true);
      try {
        await startMfaFlow(factorsData);
      } catch (mfaErr) {
        setError(mfaErr.message || "Failed to start MFA. Please try again.");
        await supabase.auth.signOut();
      } finally {
        setMfaLoading(false);
      }
      return;
    }

    let deviceTrusted = false;
    if (signInData?.session?.access_token) {
      try {
        const checkData = await apiFetch("/api/auth/check-device", { method: "POST" });
        deviceTrusted = checkData?.trusted === true;
      } catch {
        deviceTrusted = false;
      }
    }

    if (deviceTrusted) {
      if (
        isNative &&
        biometryAvailable &&
        !storedBiometricEmail &&
        !localStorage.getItem("face_id_prompted") &&
        passArg
      ) {
        await Preferences.set({ key: "__bio_enroll_pending", value: passArg });
      }
      onLoginSuccess?.();
    } else {
      setMfaLoading(true);
      try {
        await startMfaFlow();
      } catch (mfaErr) {
        setError(mfaErr.message || "Failed to start MFA. Please try again.");
        await supabase.auth.signOut();
      } finally {
        setMfaLoading(false);
      }
    }
  };

  const handleFaceIdSignIn = async () => {
    setFaceIdLoading(true);
    setError("");
    try {
      await BiometricAuth.authenticate({ reason: "Sign in to Lost & Hound" });
      const { value: storedPass } = await Preferences.get({ key: "__bio_credential" });
      if (!storedPass) throw new Error("No stored credential");
      await doSignIn(storedBiometricEmail, storedPass);
    } catch (err) {
      const msg = err?.message || "";
      if (msg.toLowerCase().includes("cancel") || msg.toLowerCase().includes("user cancel")) return;
      setError("Face ID sign-in failed. Please sign in with your password.");
      localStorage.removeItem("biometric_email");
      await Preferences.remove({ key: "__bio_credential" });
      setStoredBiometricEmail(null);
    } finally {
      setFaceIdLoading(false);
    }
  };

  const handlePasskeySignIn = async () => {
    setPasskeyLoading(true);
    setError("");
    try {
      const options = await apiFetch("/api/passkeys/authenticate/options", {
        method: "POST",
        body: JSON.stringify({ email: passkeyEmail }),
      });
      const assertionResp = await startAuthentication({ optionsJSON: options });
      const result = await apiFetch("/api/passkeys/authenticate/verify", {
        method: "POST",
        body: JSON.stringify({ response: assertionResp, email: passkeyEmail }),
      });
      if (!result.verified) throw new Error("Passkey verification failed.");
      const { error: otpError } = await supabase.auth.verifyOtp({
        token_hash: result.hashedToken,
        type: "magiclink",
      });
      if (otpError) throw otpError;
      if (result.deviceToken) {
        localStorage.setItem("device_token", result.deviceToken);
      }
      onLoginSuccess?.();
    } catch (err) {
      const msg = err?.message || "";
      if (msg.toLowerCase().includes("cancel") || err?.name === "NotAllowedError") return;
      setError("Passkey sign-in failed. Please sign in with your password.");
    } finally {
      setPasskeyLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setMessage("");

    if (!email.endsWith("@northeastern.edu")) {
      setError("You must use a @northeastern.edu email address.");
      return;
    }

    if (isSignUp && (!firstName.trim() || !lastName.trim())) {
      setError("Please enter your first and last name.");
      return;
    }

    if (isSignUp && (firstName.trim().length > NAME_MAX_LENGTH || lastName.trim().length > NAME_MAX_LENGTH)) {
      setError(`First and last name must be ${NAME_MAX_LENGTH} characters or fewer.`);
      return;
    }

    if (isSignUp && !referralSource) {
      setError("Please let us know how you found us.");
      return;
    }

    if (password.length > PASSWORD_MAX_LENGTH) {
      setError(`Password must be ${PASSWORD_MAX_LENGTH} characters or fewer.`);
      return;
    }

    try {
      if (isSignUp) {
        // Show terms modal first — sign-up happens after acceptance
        if (!termsAccepted) {
          setTermsOpen(true);
          return;
        }
        await doSignUp();
      } else {
        await doSignIn(email, password);
      }
    } catch (err) {
      setError(cleanErrorMessage(err.message || err.code));
    }
  };

  const handleOtpSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (!/^\d{6}$/.test(otpCode)) {
      setError("Please enter a valid 6-digit authenticator code.");
      return;
    }
    if (!mfaFactorId || !mfaChallengeId) {
      setError("MFA challenge is missing. Please go back and sign in again.");
      return;
    }

    setMfaVerifying(true);
    try {
      onLoginSuccess?.();

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: mfaFactorId,
        challengeId: mfaChallengeId,
        code: otpCode,
      });
      if (verifyError) throw verifyError;

      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData?.session?.access_token) throw new Error("Session expired. Please sign in again.");

      const trustResult = await apiFetch("/api/auth/trust-device", {
        method: "POST",
        body: JSON.stringify({ rememberDevice }),
      });
      if (trustResult?.deviceToken) {
        localStorage.setItem("device_token", trustResult.deviceToken);
      }
    } catch (err) {
      onLoginCancel?.();
      setError(err.message || "Verification failed. Please try again.");
    } finally {
      setMfaVerifying(false);
    }
  };

  const handleResendOtp = async () => {
    setError("");
    setMessage("");
    if (!mfaFactorId) {
      setError("No MFA factor found. Please go back and sign in again.");
      return;
    }
    setMfaLoading(true);
    try {
      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: mfaFactorId,
      });
      if (challengeError) throw challengeError;
      setMfaChallengeId(challengeData.id);
      setMessage("Challenge refreshed. Enter the current code from your authenticator app.");
      setOtpCode("");
    } catch (err) {
      setError(err.message || "Failed to refresh MFA challenge");
    } finally {
      setMfaLoading(false);
    }
  };

  const isSvgMarkup = typeof mfaQrCodeSvg === "string" && mfaQrCodeSvg.trim().startsWith("<svg");
  const isDataUri = typeof mfaQrCodeSvg === "string" && mfaQrCodeSvg.trim().startsWith("data:image");
  const qrImgSrc = !mfaQrCodeSvg
    ? ""
    : isDataUri
      ? mfaQrCodeSvg
      : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(mfaQrCodeSvg)}`;

  return (
    <>
      <ConfettiCanvas active={loginTransition || demoLaunching} />

      <Box
        sx={{
          ...(!isSignUp && isNative && {
            position: { xs: "fixed", md: "static" },
            top: 0, left: 0, right: 0, bottom: 0,
          }),
          minHeight: "100dvh",
          display: "flex",
          alignItems: { xs: "stretch", md: "center" },
          justifyContent: "center",
          background: `radial-gradient(circle, ${BRAND.dot} 1px, transparent 1px)`,
          backgroundColor: BRAND.bg,
          backgroundSize: "24px 24px",
          p: { xs: 0, md: 4 },
          transition: "opacity 0.8s ease, filter 0.8s ease, transform 0.35s cubic-bezier(0.25, 0.46, 0.45, 0.94)",
          transform: isNative && keyboardH > 0 ? `translateY(-${Math.round(keyboardH / 2)}px)` : "none",
          ...(fadeOut && {
            opacity: 0,
            filter: "blur(6px)",
          }),
        }}
      >
        <Paper
          elevation={0}
          sx={{
            display: "flex",
            flexDirection: { xs: "column", md: "row" },
            maxWidth: 880,
            width: "100%",
            borderRadius: { xs: 0, md: 4 },
            overflow: { xs: isNative ? "hidden" : "auto", md: "hidden" },
            background: BRAND.paper,
            border: { xs: "none", md: `1.5px solid ${BRAND.border}` },
            boxShadow: {
              xs: "none",
              md: isDark
                ? "0 12px 48px rgba(0,0,0,0.55), 0 4px 16px rgba(0,0,0,0.35)"
                : "0 12px 48px rgba(168, 77, 72, 0.28), 0 4px 16px rgba(0,0,0,0.1)",
            },
            transition: "transform 0.7s cubic-bezier(.4,0,.2,1), box-shadow 0.7s ease",
            ...(loginTransition && {
              transform: "scale(1.02)",
              boxShadow:
                isDark
                  ? "0 16px 64px rgba(0,0,0,0.58), 0 4px 16px rgba(0,0,0,0.35)"
                  : "0 16px 64px rgba(168, 77, 72, 0.25), 0 4px 16px rgba(0,0,0,0.08)",
            }),
          }}
        >
          {/* --- Left panel: branding --- */}
          <Box
            sx={{
              flex: 1,
              p: { xs: 3, md: 5 },
              pt: { xs: "calc(52px + env(safe-area-inset-top))", md: 5 },
              pb: { xs: 4, md: 5 },
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              background: BRAND.leftPanelGradient,
              position: "relative",
              overflow: "hidden",
              minHeight: "auto",
            }}
          >
            <Box
              sx={{
                position: "absolute",
                width: 300,
                height: 300,
                borderRadius: "50%",
                background:
                  "radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 70%)",
                bottom: -80,
                right: -80,
                pointerEvents: "none",
              }}
            />
            <Box
              sx={{
                position: "absolute",
                width: 200,
                height: 200,
                borderRadius: "50%",
                background:
                  "radial-gradient(circle, rgba(255,255,255,0.08) 0%, transparent 70%)",
                top: -60,
                left: -60,
                pointerEvents: "none",
              }}
            />

            <Box
              sx={{
                position: "relative",
                zIndex: 1,
                width: "100%",
                display: "flex",
                justifyContent: "center",
                mt: { xs: 2, md: 0 },
              }}
            >
              <Box
                component="img"
                src="/MainLogoTextAlt.png"
                alt="Lost & Hound"
                sx={{
                  width: { xs: "68%", md: "82%" },
                  maxWidth: 260,
                  minWidth: 160,
                  height: "auto",
                  objectFit: "contain",
                  display: "block",
                  mb: 2,
                }}
              />
            </Box>

            <Box sx={{ position: "relative", zIndex: 1 }}>
              <Typography
                sx={{
                  fontSize: { xs: 22, md: 28 },
                  fontWeight: 800,
                  color: "#fff",
                  lineHeight: 1.3,
                  mb: 1.5,
                }}
              >
                Find What's Lost,
                <br />
                Help What's Found
              </Typography>
              <Typography
                variant="body2"
                sx={{ color: BRAND.leftPanelBody, lineHeight: 1.6 }}
              >
                Northeastern's community-powered lost & found platform.
              </Typography>

              {/* Community counter — always rendered to avoid pop-in */}
              <Box sx={{ mt: 2.5, display: "flex", alignItems: "center", gap: 1 }}>
                <Box sx={{
                  background: "rgba(255,255,255,0.15)",
                  border: "1px solid rgba(255,255,255,0.25)",
                  borderRadius: 2,
                  px: 1.5, py: 0.75,
                  backdropFilter: "blur(6px)",
                  minWidth: 52,
                  textAlign: "center",
                }}>
                  <Typography sx={{ fontWeight: 900, fontSize: { xs: 20, md: 24 }, color: "#fff", lineHeight: 1, letterSpacing: "-0.5px" }}>
                    {displayCount > 0 ? `${displayCount}+` : "0+"}
                  </Typography>
                </Box>
                <Typography variant="body2" sx={{ color: "rgba(255,255,255,0.85)", fontWeight: 600, lineHeight: 1.3 }}>
                  Huskies in the community
                </Typography>
              </Box>
            </Box>

            <Box
              component="a"
              href="https://apps.apple.com/app/id6762494274"
              target="_blank"
              rel="noopener noreferrer"
              sx={{
                mt: 3,
                display: "flex",
                alignItems: "center",
                gap: 1,
                background: "rgba(255,255,255,0.12)",
                border: "1px solid rgba(255,255,255,0.2)",
                borderRadius: 2,
                px: 2,
                py: 1,
                backdropFilter: "blur(6px)",
                textDecoration: "none",
                position: "relative",
                zIndex: 1,
                transition: "background 0.2s",
                "&:hover": { background: "rgba(255,255,255,0.18)" },
              }}
            >
              <AppleIcon sx={{ color: "#fff", fontSize: 22 }} />
              <Box>
                <Typography sx={{ color: "rgba(255,255,255,0.6)", fontSize: 10, fontWeight: 600, lineHeight: 1 }}>
                  Available on the
                </Typography>
                <Typography sx={{ color: "#fff", fontSize: 14, fontWeight: 800, lineHeight: 1.3 }}>
                  App Store
                </Typography>
              </Box>
            </Box>

            <Typography
              variant="caption"
              sx={{
                color: BRAND.leftPanelCaption,
                mt: 2,
                position: "relative",
                zIndex: 1,
              }}
            >
              Made for Oasis @ Northeastern
            </Typography>

          </Box>

          {/* --- Right panel: form --- */}
          <Box
            sx={{
              flex: 1,
              p: { xs: 3, md: 5 },
              pt: { xs: 3, md: 5 },
              pb: { xs: "calc(32px + env(safe-area-inset-bottom))", md: 5 },
              display: "flex",
              flexDirection: "column",
              justifyContent: { xs: "flex-start", md: "center" },
              position: "relative",
            }}
          >
            {/* Loading bar — shown while MFA is being set up */}
            <LinearProgress
              sx={{
                position: "absolute",
                bottom: 0,
                left: 0,
                right: 0,
                borderRadius: "0 0 12px 12px",
                height: 3,
                opacity: mfaLoading ? 1 : 0,
                transition: "opacity 0.3s ease",
                "& .MuiLinearProgress-bar": {
                  background: `linear-gradient(90deg, ${BRAND.accent}, ${BRAND.accentHover})`,
                },
                backgroundColor: "transparent",
              }}
            />
            {loginTransition ? (
              <Box
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  py: 8,
                  animation: "popIn 0.4s cubic-bezier(.175,.885,.32,1.275) forwards",
                  "@keyframes popIn": {
                    "0%": { opacity: 0, transform: "scale(0.8)" },
                    "100%": { opacity: 1, transform: "scale(1)" },
                  },
                }}
              >
                <Typography sx={{ fontSize: 48, mb: 1, lineHeight: 1 }} role="img" aria-label="party">
                  🎉
                </Typography>
                <Typography variant="h5" fontWeight={800} sx={{ color: BRAND.title, mb: 0.5 }}>
                  Welcome back!
                </Typography>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  Signing you in…
                </Typography>
              </Box>
            ) : authStep === "mfa" ? (
              /* ── Supabase authenticator MFA step ── */
              <Box component="form" onSubmit={handleOtpSubmit} noValidate>
                <Typography variant="h5" fontWeight={800} sx={{ color: BRAND.title, mb: 0.5 }}>
                  {mfaQrCodeSvg ? "Set up your authenticator app" : "Enter authenticator code"}
                </Typography>
                <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
                  {mfaQrCodeSvg
                    ? "Scan the QR code in your authenticator app (Duo is highly recommended) then enter the 6-digit code below."
                    : "Use the 6-digit code from your authenticator app to finish signing in."}
                </Typography>

                {mfaQrCodeSvg && (
                  <Box sx={{ mb: 2, display: "flex", justifyContent: "center" }}>
                    {isSvgMarkup ? (
                      <Box
                        aria-label="Authenticator QR code"
                        sx={{
                          width: 200,
                          height: 200,
                          borderRadius: 2,
                          border: `1px solid ${BRAND.border}`,
                          p: 1,
                          background: "#fff",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          "& svg": { width: "100%", height: "100%" },
                        }}
                        dangerouslySetInnerHTML={{ __html: mfaQrCodeSvg }}
                      />
                    ) : (
                      <Box
                        component="img"
                        alt="Authenticator QR code"
                        src={qrImgSrc}
                        sx={{ width: 200, height: 200, borderRadius: 2, border: `1px solid ${BRAND.border}`, p: 1, background: "#fff" }}
                      />
                    )}
                  </Box>
                )}

                {mfaUri && (() => {
                  const secret = new URL(mfaUri).searchParams.get("secret") ?? mfaUri;
                  return (
                    <Box sx={{ mb: 2 }}>
                      <Typography variant="caption" sx={{ display: "block", mb: 0.5, color: "text.secondary" }}>
                        Trouble scanning? Enter this code manually in your authenticator app:
                      </Typography>
                      <Box sx={{ display: "flex", alignItems: "center", gap: 1, background: "rgba(0,0,0,0.06)", borderRadius: 1, px: 1.5, py: 0.75 }}>
                        <Typography variant="body2" sx={{ fontFamily: "monospace", letterSpacing: 1, flexGrow: 1, userSelect: "all" }}>
                          {secret}
                        </Typography>
                        <Tooltip title="Copy">
                          <IconButton size="small" onClick={() => navigator.clipboard.writeText(secret)}>
                            <ContentCopyIcon sx={{ fontSize: 16 }} />
                          </IconButton>
                        </Tooltip>
                      </Box>
                    </Box>
                  );
                })()}

                <TextField
                  required
                  fullWidth
                  size="small"
                  label="Verification code"
                  placeholder="000000"
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputProps={{ maxLength: 6, inputMode: "numeric", pattern: "\\d{6}" }}
                  onKeyDown={dismissKeyboardOnEnter}
                  autoFocus
                  sx={{ ...autofillTextFieldSx, mb: 2 }}
                />

                <FormControlLabel
                  control={
                    <Checkbox
                      checked={rememberDevice}
                      onChange={(e) => setRememberDevice(e.target.checked)}
                      sx={{ color: BRAND.accent, "&.Mui-checked": { color: BRAND.accent } }}
                    />
                  }
                  label={
                    <Typography variant="body2" sx={{ color: "text.secondary" }}>
                      Remember this device for 30 days
                    </Typography>
                  }
                  sx={{ mb: 2 }}
                />

                <Button
                  type="submit"
                  fullWidth
                  variant="contained"
                  disabled={mfaVerifying || otpCode.length !== 6}
                  sx={{
                    py: 1.25,
                    background: BRAND.accent,
                    "&:hover": { background: BRAND.accentHover },
                    fontWeight: 700,
                    borderRadius: 2,
                    fontSize: 15,
                    textTransform: "none",
                    mb: 1.5,
                  }}
                >
                  {mfaVerifying ? <CircularProgress size={20} sx={{ color: "#fff" }} /> : "Verify"}
                </Button>

                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <MuiLink
                    component="button"
                    type="button"
                    variant="body2"
                    onClick={handleResendOtp}
                    disabled={mfaLoading}
                    sx={{ cursor: "pointer", color: BRAND.accent, fontWeight: 600 }}
                  >
                    {mfaLoading ? "Refreshing…" : "Refresh challenge"}
                  </MuiLink>
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>·</Typography>
                  <MuiLink
                    component="button"
                    type="button"
                    variant="body2"
                    onClick={async () => {
                      await supabase.auth.signOut();
                      setAuthStep("credentials");
                      setOtpCode("");
                      setMfaFactorId("");
                      setMfaChallengeId("");
                      setMfaQrCodeSvg("");
                      setMfaUri("");
                      setError("");
                      setMessage("");
                    }}
                    sx={{ cursor: "pointer", color: BRAND.accent, fontWeight: 600 }}
                  >
                    Back to sign in
                  </MuiLink>
                </Box>

                {error   && <Alert severity="error"   sx={{ mt: 2 }}>{error}</Alert>}
                {message && <Alert severity="success" sx={{ mt: 2 }}>{message}</Alert>}
              </Box>
            ) : (
              <>
                <Typography
                  variant="h5"
                  fontWeight={800}
                  sx={{ color: BRAND.title, mb: 0.5 }}
                >
                  {isSignUp ? "Create an account" : "Sign in"}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ color: "text.secondary", mb: 3 }}
                >
                  {isSignUp
                    ? "Already have an account?"
                    : "Don't have an account?"}{" "}
                  <MuiLink
                    component="button"
                    variant="body2"
                    onClick={() => {
                      setIsSignUp(!isSignUp);
                      setError("");
                      setMessage("");
                      setFirstName("");
                      setLastName("");
                    }}
                    sx={{
                      cursor: "pointer",
                      color: BRAND.accent,
                      fontWeight: 700,
                      textDecoration: "none",
                      "&:hover": { textDecoration: "underline" },
                    }}
                  >
                    {isSignUp ? "Log In" : "Sign Up"}
                  </MuiLink>
                </Typography>

                {!isSignUp && biometryAvailable && storedBiometricEmail && !manualMode ? (
                  /* ── Face ID sign-in mode ── */
                  <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <Button
                      fullWidth
                      variant="contained"
                      onClick={handleFaceIdSignIn}
                      disabled={faceIdLoading}
                      startIcon={faceIdLoading ? <CircularProgress size={18} /> : null}
                      sx={{
                        py: 1.5,
                        background: BRAND.accent,
                        "&:hover": { background: BRAND.accentHover },
                        fontWeight: 700,
                        borderRadius: 2,
                        fontSize: 15,
                        textTransform: "none",
                      }}
                    >
                      {faceIdLoading ? "Signing in…" : `Sign in as ${storedBiometricEmail}`}
                    </Button>
                    <MuiLink
                      component="button"
                      type="button"
                      variant="body2"
                      onClick={() => setManualMode(true)}
                      sx={{
                        display: "block",
                        textAlign: "center",
                        mt: 1.5,
                        color: "text.secondary",
                        fontWeight: 500,
                        cursor: "pointer",
                        textDecoration: "none",
                        "&:hover": { color: BRAND.accent },
                      }}
                    >
                      Use password instead
                    </MuiLink>
                  </Box>
                ) : (
                  /* ── Password / sign-up form ── */
                  <Box component="form" onSubmit={handleSubmit} noValidate>
                    {isSignUp && (
                      <>
                        <Box sx={{ display: "flex", flexDirection: { xs: "column", sm: "row" }, gap: 1.5, mb: 0.75 }}>
                          <TextField
                            required
                            fullWidth
                            size="small"
                            label="First Name"
                            value={firstName}
                            onChange={(e) => setFirstName(e.target.value.slice(0, NAME_MAX_LENGTH))}
                            inputProps={{ maxLength: NAME_MAX_LENGTH, autoCapitalize: "words" }}
                            onKeyDown={dismissKeyboardOnEnter}
                            helperText={`${stripInvisible(firstName).length}/${NAME_MAX_LENGTH}`}
                            sx={autofillTextFieldSx}
                          />
                          <TextField
                            required
                            fullWidth
                            size="small"
                            label="Last Name"
                            value={lastName}
                            onChange={(e) => setLastName(e.target.value.slice(0, NAME_MAX_LENGTH))}
                            inputProps={{ maxLength: NAME_MAX_LENGTH, autoCapitalize: "words" }}
                            onKeyDown={dismissKeyboardOnEnter}
                            helperText={`${stripInvisible(lastName).length}/${NAME_MAX_LENGTH}`}
                            sx={autofillTextFieldSx}
                          />
                        </Box>
                        <Typography variant="caption" sx={{ display: "block", mb: 1.5, color: isDark ? "#A9AAAB" : "text.secondary" }}>
                          Max {NAME_MAX_LENGTH} characters for first and last name.
                        </Typography>

                        <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.75, mb: 1.5 }}>
                          <FormControl fullWidth size="small">
                            <InputLabel sx={{ fontSize: 14 }}>How did you find us?</InputLabel>
                            <Select
                              value={referralSource}
                              label="How did you find us?"
                              onChange={(e) => setReferralSource(e.target.value)}
                              sx={{
                                fontSize: 14,
                                background: BRAND.inputBg,
                                "& .MuiOutlinedInput-notchedOutline": { borderColor: BRAND.inputBorder },
                                "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: BRAND.inputBorderHover },
                                "& .MuiSelect-select": { color: BRAND.inputText },
                              }}
                            >
                              <MenuItem value="word_of_mouth">Word of mouth</MenuItem>
                              <MenuItem value="social_media">Instagram / Social media</MenuItem>
                              <MenuItem value="reddit">Reddit</MenuItem>
                              <MenuItem value="yikyak">YikYak</MenuItem>
                              <MenuItem value="northeastern_website">Northeastern website</MenuItem>
                              <MenuItem value="professor_class">Professor or class</MenuItem>
                              <MenuItem value="flyer_poster">Flyer or poster</MenuItem>
                              <MenuItem value="oasis_event">Oasis event</MenuItem>
                              <MenuItem value="other">Other</MenuItem>
                            </Select>
                          </FormControl>
                          <Tooltip title="This is collected anonymously and is never linked to your account." placement="top">
                            <InfoOutlinedIcon sx={{ fontSize: 15, mt: 1.1, color: "text.disabled", cursor: "help", flexShrink: 0 }} />
                          </Tooltip>
                        </Box>
                      </>
                    )}

                    <TextField
                      ref={emailRef}
                      required
                      fullWidth
                      size="small"
                      label="Email"
                      placeholder="you@northeastern.edu"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="email"
                      inputProps={{ autoCapitalize: "none" }}
                      onKeyDown={dismissKeyboardOnEnter}
                      sx={{ ...autofillTextFieldSx, mb: 1.5 }}
                    />

                    <TextField
                      ref={passwordRef}
                      required
                      fullWidth
                      size="small"
                      label="Password"
                      type="password"
                      placeholder="Enter your password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value.slice(0, PASSWORD_MAX_LENGTH))}
                      autoComplete="current-password"
                      inputProps={{ minLength: 6, maxLength: PASSWORD_MAX_LENGTH, autoCapitalize: "none" }}
                      onKeyDown={dismissKeyboardOnEnter}
                      sx={{ ...autofillTextFieldSx, mb: 3 }}
                    />

                    <Button
                      type="submit"
                      fullWidth
                      variant="contained"
                      sx={{
                        py: 1.25,
                        background: BRAND.accent,
                        "&:hover": { background: BRAND.accentHover },
                        fontWeight: 700,
                        borderRadius: 2,
                        fontSize: 15,
                        textTransform: "none",
                      }}
                    >
                      {isSignUp ? "Create account" : "Sign in"}
                    </Button>
                  </Box>
                )}

                {!isSignUp && (
                  <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 1, mt: 2.5 }}>
                    {[
                      { label: "Forgot Password", icon: <LockResetIcon sx={{ fontSize: 18 }} />, action: () => navigate("/forgot-password") },
                      { label: "Support", icon: <HelpOutlineIcon sx={{ fontSize: 18 }} />, action: () => setSupportOpen(true) },
                      ...(manualMode && biometryAvailable && storedBiometricEmail
                        ? [{ label: "Use Face ID", icon: <FaceIcon sx={{ fontSize: 18 }} />, action: () => setManualMode(false) }]
                        : []),
                      ...(passkeyEmail && !passkeyLoading
                        ? [{ label: "Use Fingerprint", icon: <FingerprintIcon sx={{ fontSize: 18 }} />, action: handlePasskeySignIn }]
                        : passkeyLoading
                          ? [{ label: "Signing in…", icon: <CircularProgress size={14} />, action: () => {} }]
                          : []),
                    ].map((item) => (
                      <Box
                        key={item.label}
                        onClick={item.action}
                        sx={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 0.75,
                          px: 2,
                          py: 0.85,
                          borderRadius: 2,
                          cursor: "pointer",
                          border: `1px solid ${BRAND.border}`,
                          bgcolor: isDark ? "rgba(255,255,255,0.04)" : "rgba(168,77,72,0.04)",
                          color: BRAND.accent,
                          fontSize: 14,
                          fontWeight: 700,
                          transition: "all 0.2s",
                          "&:hover": {
                            bgcolor: isDark ? "rgba(255,69,0,0.1)" : "rgba(168,77,72,0.1)",
                            borderColor: BRAND.accent,
                            transform: "translateY(-1px)",
                          },
                        }}
                      >
                        {item.icon}
                        {item.label}
                      </Box>
                    ))}
                  </Box>
                )}

                {error && (
                  <Alert severity="error" sx={{ mt: 2, textAlign: "left" }}>
                    {error === "EMAIL_NOT_CONFIRMED" ? (
                      <>
                        <strong>Email not confirmed.</strong> Please check your inbox for the verification link.
                        <Typography
                          variant="caption"
                          sx={{
                            display: "block",
                            mt: 1,
                            color: "inherit",
                            opacity: 0.85,
                            lineHeight: 1.5,
                          }}
                        >
                          Can't find it? Northeastern's email system may quarantine messages from new senders.
                          Check your <strong>Junk/Spam</strong> folder, or visit{" "}
                          <MuiLink
                            href="https://security.microsoft.com/quarantine"
                            target="_blank"
                            rel="noopener noreferrer"
                            sx={{ color: "inherit", fontWeight: 700 }}
                          >
                            Microsoft 365 Quarantine
                          </MuiLink>{" "}
                          and release the email from there.
                        </Typography>
                        <MuiLink
                          component="button"
                          variant="body2"
                          onClick={handleResendConfirmation}
                          disabled={resendingEmail}
                          sx={{
                            display: "block",
                            mt: 1.5,
                            color: "inherit",
                            fontWeight: 700,
                            cursor: resendingEmail ? "default" : "pointer",
                            opacity: resendingEmail ? 0.6 : 1,
                          }}
                        >
                          {resendingEmail ? "Sending..." : "Resend verification email"}
                        </MuiLink>
                        {resendMessage && (
                          <Typography
                            variant="caption"
                            sx={{ display: "block", mt: 0.5, color: "inherit", fontWeight: 600 }}
                          >
                            {resendMessage}
                          </Typography>
                        )}
                      </>
                    ) : (
                      error
                    )}
                  </Alert>
                )}
                {message && (
                  <Alert severity="success" sx={{ mt: 2, textAlign: "left" }}>
                    {message === "SIGNUP_SUCCESS" ? (
                      <>
                        <strong>Account created!</strong> Check your Northeastern email for a verification link.
                        <Typography
                          variant="caption"
                          sx={{
                            display: "block",
                            mt: 1,
                            color: "inherit",
                            opacity: 0.85,
                            lineHeight: 1.5,
                          }}
                        >
                          Can't find it? Northeastern's email system may quarantine messages from new senders.
                          Check your <strong>Junk/Spam</strong> folder, or visit{" "}
                          <MuiLink
                            href="https://security.microsoft.com/quarantine"
                            target="_blank"
                            rel="noopener noreferrer"
                            sx={{ color: "inherit", fontWeight: 700 }}
                          >
                            Microsoft 365 Quarantine
                          </MuiLink>{" "}
                          and release the email from there.
                        </Typography>
                      </>
                    ) : (
                      message
                    )}
                  </Alert>
                )}
              </>
            )}

            {!loginTransition && !demoLaunching && (
              <Box sx={{ mt: 3, textAlign: "center" }}>
                <Box sx={{ display: "flex", justifyContent: "center", gap: 1, mb: 2 }}>
                  {[
                    { label: "Privacy", icon: <ShieldOutlinedIcon sx={{ fontSize: 15 }} />, action: () => navigate("/privacy") },
                    { label: "Credits", icon: <PeopleAltOutlinedIcon sx={{ fontSize: 15 }} />, action: () => navigate("/credits") },
                  ].map((item) => (
                    <Box
                      key={item.label}
                      onClick={item.action}
                      sx={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 0.5,
                        px: 1.5,
                        py: 0.5,
                        borderRadius: 2,
                        cursor: "pointer",
                        border: `1px solid ${BRAND.border}`,
                        bgcolor: isDark ? "rgba(255,255,255,0.04)" : "rgba(168,77,72,0.04)",
                        color: BRAND.accent,
                        fontSize: 12,
                        fontWeight: 600,
                        transition: "all 0.2s",
                        "&:hover": {
                          bgcolor: isDark ? "rgba(255,69,0,0.1)" : "rgba(168,77,72,0.1)",
                          borderColor: BRAND.accent,
                          transform: "translateY(-1px)",
                        },
                      }}
                    >
                      {item.icon}
                      {item.label}
                    </Box>
                  ))}
                </Box>
                <Typography
                  variant="caption"
                  onClick={() => setDemoOpen(true)}
                  sx={{
                    display: "block",
                    color: BRAND.accent,
                    cursor: "pointer",
                    fontWeight: 700,
                    textDecoration: "underline",
                    textUnderlineOffset: 3,
                    "&:hover": { opacity: 0.75 },
                  }}
                >
                  Want to preview our project?
                </Typography>
              </Box>
            )}
          </Box>
        </Paper>
      </Box>

      {/* Terms & Conditions modal — shows before sign-up */}
      <TermsModal
        open={termsOpen}
        onClose={() => setTermsOpen(false)}
        effectiveTheme={effectiveTheme}
        onAccept={() => {
          setTermsAccepted(true);
          // Run sign-up now that terms are accepted
          doSignUp();
        }}
      />

      {/* Support modal — available from login page without authentication */}
      <LoginSupportModal
        open={supportOpen}
        onClose={() => setSupportOpen(false)}
        effectiveTheme={effectiveTheme}
      />

      {/* Demo preview modal */}
      <DemoModal
        open={demoOpen}
        onClose={() => setDemoOpen(false)}
        onViewDemo={handleViewDemo}
        effectiveTheme={effectiveTheme}
      />

    </>
  );
}

function cleanErrorMessage(errorMsg) {
  if (!errorMsg) return "Something went wrong. Please try again.";
  if (errorMsg.toLowerCase().includes("email not confirmed"))
    return "EMAIL_NOT_CONFIRMED";
  if (errorMsg.toLowerCase().includes("user already registered"))
    return "An account with this email already exists.";
  if (errorMsg.toLowerCase().includes("email already registered"))
    return "An account with this email already exists.";
  if (errorMsg.includes("Invalid login credentials"))
    return "Incorrect email or password.";
  if (errorMsg.includes("user not found"))
    return "No account found with this email.";
  if (errorMsg.includes("6 characters"))
    return "Password must be at least 6 characters.";
  if (errorMsg.includes("rate limit"))
    return "Too many attempts. Please try again later.";
  if (errorMsg.includes("valid email"))
    return "Please enter a valid email address.";
  return errorMsg;
}