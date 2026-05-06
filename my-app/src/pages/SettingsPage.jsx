// --- SettingsPage: User account settings UI ---
import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Capacitor } from "@capacitor/core";
import { startRegistration } from "@simplewebauthn/browser";
import { BiometricAuth } from "@aparajita/capacitor-biometric-auth";
import { Preferences } from "@capacitor/preferences";
import { supabase } from "../../backend/supabaseClient";
import apiFetch from "../utils/apiFetch";
import { useDemo } from "../contexts/DemoContext";
import { DEMO_PROFILE } from "../demo/mockData";
import { containsProfanity, stripInvisible } from "../utils/profanityFilter";
import { dismissKeyboard, dismissKeyboardOnEnter } from "../utils/keyboard";
import {
  Container,
  Paper,
  TextField,
  Button,
  Typography,
  Box,
  Alert,
  Divider,
  Select,
  MenuItem,
  FormControl,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Switch,
  FormControlLabel,
  CircularProgress,
  IconButton,
  Chip,
  Collapse,
} from "@mui/material";
import { useAuth } from "../AuthContext";
import Avatar from "@mui/material/Avatar";
import SettingsIcon from "@mui/icons-material/Settings";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import LogoutOutlinedIcon from "@mui/icons-material/LogoutOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import BlockIcon from "@mui/icons-material/Block";
import LocationOnOutlinedIcon from "@mui/icons-material/LocationOnOutlined";
import DarkModeOutlinedIcon from "@mui/icons-material/DarkModeOutlined";
import NotificationsOutlinedIcon from "@mui/icons-material/NotificationsOutlined";
import FingerprintIcon from "@mui/icons-material/Fingerprint";
import { CAMPUSES } from "../constants/campuses";
import { TIME_ZONE_OPTIONS } from "../utils/timezone";

const NAME_MAX_LENGTH = 25;

export default function SettingsPage({
  themeMode = "auto",
  setThemeMode = () => {},
  timeZone,
  setTimeZone = () => {},
  effectiveTheme = "light",
}) {
  const isDark = effectiveTheme === "dark";
  const BRAND = {
    maroon: isDark ? "#C96E47" : "#7a2929",
    maroonDark: isDark ? "#B35D38" : "#5e1f1f",
    maroonLight: isDark ? "#DA8864" : "#a04040",
    maroonFaint: isDark ? "rgba(201,110,71,0.12)" : "rgba(122,41,41,0.06)",
    maroonFaintHover: isDark ? "rgba(201,110,71,0.18)" : "rgba(122,41,41,0.10)",
    cardBorder: isDark ? "rgba(255,255,255,0.14)" : "rgba(122,41,41,0.12)",
    textPrimary: isDark ? "#D7DADC" : "#2d2d2d",
    textSecondary: isDark ? "#818384" : "#6b6b6b",
    bg: isDark ? "#101214" : "#f9f5f4",
    dot: isDark ? "rgba(255,255,255,0.07)" : "rgba(122,41,41,0.18)",
    surface: isDark ? "#1A1A1B" : "#fff",
    inputBg: isDark ? "#2D2D2E" : "#fff",
  };

  const navigate = useNavigate();
  const { user, profile, updateProfile, logout, forgotPassword } = useAuth();
  const { isDemoMode, exitDemo } = useDemo();
  const effectiveUser = isDemoMode ? { id: 'demo-user-id', email: 'demo@northeastern.edu' } : user;
  const effectiveProfile = isDemoMode ? DEMO_PROFILE : profile;
  const [message, setMessage] = useState("");

  const [editMode, setEditMode] = useState(false);
  const [firstName, setFirstName] = useState(effectiveProfile?.first_name || "");
  const [lastName, setLastName] = useState(effectiveProfile?.last_name || "");
  const [nameMessage, setNameMessage] = useState("");
  const [nameProfane, setNameProfane] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState("");
  const [defaultCampus, setDefaultCampus] = useState(
    isDemoMode
      ? (localStorage.getItem('demo_campus') || 'boston')
      : (effectiveProfile?.default_campus || "boston")
  );
  const [campusMessage, setCampusMessage] = useState("");
  const [notifEmail, setNotifEmail] = useState(effectiveProfile?.email_notifications_enabled ?? true);
  const [notifPush, setNotifPush] = useState(effectiveProfile?.push_notifications_enabled ?? true);
  const [notifBroadcast, setNotifBroadcast] = useState(effectiveProfile?.broadcast_notifications_enabled ?? true);

  const [blockedUsers, setBlockedUsers] = useState([]);
  const [blockedOpen, setBlockedOpen] = useState(false);

  useEffect(() => {
    if (!effectiveUser || isDemoMode) return;
    supabase.from("blocked_users").select("blocked_id").eq("blocker_id", effectiveUser.id)
      .then(async ({ data }) => {
        const ids = data?.map(r => r.blocked_id) || [];
        if (!ids.length) return setBlockedUsers([]);
        const { data: profiles } = await supabase.from("profiles").select("id, first_name, last_name").in("id", ids);
        setBlockedUsers(profiles || []);
      }).catch(() => {});
  }, [effectiveUser, isDemoMode]);

  const handleUnblockUser = async (userId) => {
    try {
      await apiFetch(`/api/users/${userId}/block`, { method: "DELETE" });
      setBlockedUsers(prev => prev.filter(u => u.id !== userId));
    } catch {}
  };

  const [faceIdEnabled, setFaceIdEnabled] = useState(false);
  const [faceIdAvailable, setFaceIdAvailable] = useState(false);
  const [faceIdPasswordDialog, setFaceIdPasswordDialog] = useState(false);
  const [faceIdPassword, setFaceIdPassword] = useState("");
  const [faceIdError, setFaceIdError] = useState("");
  const [faceIdSaving, setFaceIdSaving] = useState(false);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    BiometricAuth.checkBiometry()
      .then(({ isAvailable }) => {
        if (!isAvailable) return;
        setFaceIdAvailable(true);
        setFaceIdEnabled(!!localStorage.getItem("biometric_email"));
      })
      .catch(() => {});
  }, []);

  const handleEnableFaceId = async () => {
    setFaceIdError("");
    setFaceIdSaving(true);
    try {
      await BiometricAuth.authenticate({ reason: "Enable Face ID sign-in for Lost & Hound" });
      await Preferences.set({ key: "__bio_credential", value: faceIdPassword });
      localStorage.setItem("biometric_email", effectiveUser?.email || "");
      setFaceIdEnabled(true);
      setFaceIdPasswordDialog(false);
      setFaceIdPassword("");
    } catch (err) {
      const msg = err?.message || "";
      if (msg.toLowerCase().includes("cancel") || msg.toLowerCase().includes("user cancel")) {
        setFaceIdPasswordDialog(false);
        setFaceIdPassword("");
      } else {
        setFaceIdError("Face ID setup failed. Please try again.");
      }
    } finally {
      setFaceIdSaving(false);
    }
  };

  const handleDisableFaceId = async () => {
    localStorage.removeItem("biometric_email");
    await Preferences.remove({ key: "__bio_credential" });
    setFaceIdEnabled(false);
  };

  // Web passkeys — only shown on non-native platform
  const isWeb = !Capacitor.isNativePlatform();
  const [passkeys, setPasskeys] = useState([]);
  const [passkeysLoading, setPasskeysLoading] = useState(false);
  const [passkeyAdding, setPasskeyAdding] = useState(false);
  const [passkeyMessage, setPasskeyMessage] = useState("");

  const fetchPasskeys = useCallback(async () => {
    if (!isWeb || isDemoMode || !effectiveUser) return;
    setPasskeysLoading(true);
    try {
      const data = await apiFetch("/api/passkeys");
      setPasskeys(data?.passkeys ?? []);
    } catch {
      // silently ignore — passkeys table may not exist yet
    } finally {
      setPasskeysLoading(false);
    }
  }, [isWeb, isDemoMode, effectiveUser]);

  useEffect(() => { fetchPasskeys(); }, [fetchPasskeys]);

  const handleAddPasskey = async () => {
    setPasskeyAdding(true);
    setPasskeyMessage("");
    try {
      const options = await apiFetch("/api/passkeys/register/options", { method: "POST" });
      const attResp = await startRegistration({ optionsJSON: options });
      await apiFetch("/api/passkeys/register/verify", {
        method: "POST",
        body: JSON.stringify({ response: attResp }),
      });
      localStorage.setItem("passkey_email", effectiveUser?.email || "");
      setPasskeyMessage("Passkey added! You can now sign in with your fingerprint.");
      await fetchPasskeys();
    } catch (err) {
      if (err?.name !== "NotAllowedError") {
        setPasskeyMessage(err?.message || "Failed to add passkey.");
      }
    } finally {
      setPasskeyAdding(false);
    }
  };

  const handleDeletePasskey = async (id) => {
    try {
      await apiFetch(`/api/passkeys/${id}`, { method: "DELETE" });
      const remaining = passkeys.filter((p) => p.id !== id);
      setPasskeys(remaining);
      if (remaining.length === 0) localStorage.removeItem("passkey_email");
    } catch {
      setPasskeyMessage("Failed to remove passkey.");
    }
  };

  const handleSaveNotif = async (key, value) => {
    if (isDemoMode) return;
    if (key === "emailNotifications") setNotifEmail(value);
    else if (key === "pushNotifications") setNotifPush(value);
    else if (key === "broadcastNotifications") setNotifBroadcast(value);
    const dbKey = key === "emailNotifications" ? "email_notifications_enabled"
      : key === "pushNotifications" ? "push_notifications_enabled"
      : "broadcast_notifications_enabled";
    try {
      await apiFetch("/api/settings/notifications", {
        method: "PATCH",
        body: JSON.stringify({ [key]: value }),
      });
      updateProfile({ [dbKey]: value });
    } catch {}
  };

  const handleSaveCampus = async (campusId) => {
    setDefaultCampus(campusId);
    setCampusMessage("");
    if (isDemoMode) {
      localStorage.setItem('demo_campus', campusId);
      setCampusMessage("Default campus updated!");
      setTimeout(() => setCampusMessage(""), 2000);
      return;
    }
    if (!user?.id) return;
    try {
      await apiFetch("/api/profile/campus", {
        method: "PATCH",
        body: JSON.stringify({ default_campus: campusId }),
      });
      updateProfile({ default_campus: campusId });
      setCampusMessage("Default campus updated!");
      setTimeout(() => setCampusMessage(""), 2000);
    } catch {
      setCampusMessage("Error updating campus.");
    }
  };

  const handleChangePassword = async () => {
    if (isDemoMode) { setMessage("Cannot do this action in demo mode."); return; }
    if (!user?.email) return;
    setMessage("");
    const { error } = await forgotPassword(user.email);
    if (error) {
      setMessage("Error sending password reset email.");
    } else {
      setMessage("Password reset email sent! Check your inbox.");
    }
  };

  const handleSaveName = async () => {
    if (nameProfane) return;
    setNameMessage("");
    if (isDemoMode) { setNameMessage("Cannot do this action in demo mode."); return; }
    if (!user?.id) return;

    if (
      firstName.trim().length > NAME_MAX_LENGTH ||
      lastName.trim().length > NAME_MAX_LENGTH
    ) {
      setNameMessage(`First and last name must be ${NAME_MAX_LENGTH} characters or fewer.`);
      return;
    }

    try {
      await apiFetch("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ first_name: firstName, last_name: lastName }),
      });
      updateProfile({ first_name: firstName, last_name: lastName });
      setNameMessage("Name updated!");
      setEditMode(false);
    } catch {
      setNameMessage("Error updating name.");
    }
  };

  const handleDeleteAccount = async () => {
    if (isDemoMode) { setDeleteMessage("Cannot do this action in demo mode."); setDeleteOpen(false); return; }
    if (!user?.id) return;
    setDeleteMessage("");
    try {
      await apiFetch("/api/profile", { method: "DELETE" });
      // Auth user is already deleted server-side, sign out locally to clear session
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      setDeleteMessage("Error deleting account. Please contact support.");
      setDeleteOpen(false);
    }
  };

  // --- Shared button styles ---
  const btnMain = {
    bgcolor: BRAND.maroon,
    color: "#fff",
    fontWeight: 600,
    borderRadius: 2,
    textTransform: "none",
    py: 1,
    fontSize: "0.9rem",
    boxShadow: "none",
    "&:hover": {
      bgcolor: BRAND.maroonDark,
      boxShadow: isDark
        ? "0 2px 8px rgba(201,110,71,0.22)"
        : "0 2px 8px rgba(122,41,41,0.25)",
    },
  };

  const btnOutline = {
    color: BRAND.maroon,
    borderColor: BRAND.cardBorder,
    fontWeight: 600,
    borderRadius: 2,
    textTransform: "none",
    py: 1,
    fontSize: "0.9rem",
    "&:hover": {
      borderColor: BRAND.maroon,
      bgcolor: BRAND.maroonFaint,
    },
  };

  // --- Reusable section label ---
  const SectionLabel = ({ children, icon: Icon, color }) => (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1.5 }}>
      {Icon && (
        <Icon
          sx={{ fontSize: 18, color: color || BRAND.maroon, opacity: 0.7 }}
        />
      )}
      <Typography
        variant="overline"
        sx={{
          color: color || BRAND.textSecondary,
          letterSpacing: 1.5,
          fontWeight: 700,
          fontSize: "0.7rem",
        }}
      >
        {children}
      </Typography>
    </Box>
  );

  // --- Styled text field overrides for maroon focus ---
  const textFieldSx = {
    "& .MuiOutlinedInput-root": {
      borderRadius: 2,
      bgcolor: BRAND.inputBg,
      color: BRAND.textPrimary,
      "&.Mui-focused fieldset": {
        borderColor: BRAND.maroon,
      },
      "& fieldset": {
        borderColor: BRAND.cardBorder,
      },
    },
    "& .MuiInputLabel-root": {
      color: BRAND.textSecondary,
    },
    "& .MuiInputLabel-root.Mui-focused": {
      color: BRAND.maroon,
    },
  };

  return (
    <>
      {/* --- Dotted background (matches login page) --- */}
      <Box
        sx={{
          position: "fixed",
          inset: 0,
          zIndex: -1,
          backgroundColor: BRAND.bg,
          backgroundImage:
            `radial-gradient(circle, ${BRAND.dot} 1px, transparent 1px)`,
          backgroundSize: "24px 24px",
        }}
      />

      {/* --- Centered content --- */}
      <Box
        sx={{
          minHeight: "calc(100dvh - 100px)",
          boxSizing: "border-box",
          display: "flex",
          alignItems: { xs: "flex-start", md: "center" },
          justifyContent: "center",
          px: 2,
          py: { xs: 2, md: 3 },
        }}
      >
        <Container component="main" maxWidth="md">
          <Paper
            elevation={0}
            sx={{
              p: { xs: 3, sm: 4, md: 4 },
              width: "100%",
              borderRadius: 3,
              backgroundColor: BRAND.surface,
              border: `1px solid ${BRAND.cardBorder}`,
              boxShadow: "0 10px 40px rgba(0,0,0,0.12), 0 2px 10px rgba(0,0,0,0.06)",
            }}
          >
            {/* --- Header row --- */}
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 2,
                mb: 1,
              }}
            >
              <Avatar
                sx={{
                  bgcolor: BRAND.maroonFaint,
                  color: BRAND.maroon,
                  width: 52,
                  height: 52,
                }}
              >
                <SettingsIcon fontSize="large" />
              </Avatar>
              <Box>
                <Typography
                  variant="h5"
                  sx={{ fontWeight: 700, color: BRAND.textPrimary }}
                >
                  Account Settings
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ color: BRAND.textSecondary, mt: 0.25 }}
                >
                  Manage your profile and security
                </Typography>
              </Box>
            </Box>

            <Divider sx={{ my: 3, borderColor: BRAND.cardBorder }} />

            {/* --- Two-column layout --- */}
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
                gap: { xs: 3, sm: 5 },
              }}
            >
              {/* === LEFT COLUMN: Profile & Security === */}
              <Box>
                <SectionLabel icon={EditOutlinedIcon}>Profile</SectionLabel>

                {/* Email */}
                <Box
                  sx={{
                    bgcolor: BRAND.maroonFaint,
                    borderRadius: 2,
                    px: 2,
                    py: 1.5,
                    mb: 2,
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{ color: BRAND.textSecondary, fontWeight: 500 }}
                  >
                    Email
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{ fontWeight: 600, color: BRAND.maroon }}
                  >
                    {effectiveUser?.email}
                  </Typography>
                </Box>

                {/* Name */}
                <Box
                  sx={{
                    bgcolor: BRAND.maroonFaint,
                    borderRadius: 2,
                    px: 2,
                    py: 1.5,
                    mb: 2,
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{ color: BRAND.textSecondary, fontWeight: 500 }}
                  >
                    Name
                  </Typography>
                  {editMode ? (
                    <Box sx={{ mt: 1 }}>
                      <Box sx={{ display: "flex", flexDirection: { xs: "column", sm: "row" }, gap: 1.5, mb: 1.5 }}>
                        <TextField
                          label="First Name"
                          value={firstName}
                          onChange={(e) => {
                            const v = e.target.value.slice(0, NAME_MAX_LENGTH);
                            setFirstName(v);
                            setNameProfane(containsProfanity(v) || containsProfanity(lastName));
                          }}
                          size="small"
                          inputProps={{ maxLength: NAME_MAX_LENGTH }}
                          onKeyDown={dismissKeyboardOnEnter}
                          error={nameProfane && containsProfanity(firstName)}
                          helperText={nameProfane && containsProfanity(firstName) ? "Cannot use that word" : `${stripInvisible(firstName).length}/${NAME_MAX_LENGTH}`}
                          sx={{ flex: 1, borderRadius: 2, ...textFieldSx }}
                        />
                        <TextField
                          label="Last Name"
                          value={lastName}
                          onChange={(e) => {
                            const v = e.target.value.slice(0, NAME_MAX_LENGTH);
                            setLastName(v);
                            setNameProfane(containsProfanity(firstName) || containsProfanity(v));
                          }}
                          size="small"
                          inputProps={{ maxLength: NAME_MAX_LENGTH }}
                          onKeyDown={dismissKeyboardOnEnter}
                          error={nameProfane && containsProfanity(lastName)}
                          helperText={nameProfane && containsProfanity(lastName) ? "Cannot use that word" : `${stripInvisible(lastName).length}/${NAME_MAX_LENGTH}`}
                          sx={{ flex: 1, borderRadius: 2, ...textFieldSx }}
                        />
                      </Box>
                      <Typography variant="caption" sx={{ color: BRAND.textSecondary, display: "block", mb: 1 }}>
                        Max {NAME_MAX_LENGTH} characters for first and last name.
                      </Typography>
                      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                        <Button
                          variant="contained"
                          size="small"
                          sx={{ ...btnMain, py: 0.5, px: 2.5 }}
                          onClick={handleSaveName}
                        >
                          Save
                        </Button>
                        <Button
                          variant="outlined"
                          size="small"
                          sx={{ ...btnOutline, py: 0.5, px: 2 }}
                          onClick={() => {
                            setEditMode(false);
                            setNameMessage("");
                          }}
                        >
                          Cancel
                        </Button>
                      </Box>
                    </Box>
                  ) : (
                    <Box sx={{ display: "flex", alignItems: "center" }}>
                      <Typography
                        variant="body2"
                        sx={{ fontWeight: 600, color: BRAND.maroon }}
                      >
                        {effectiveProfile?.first_name} {effectiveProfile?.last_name}
                      </Typography>
                      <Button
                        size="small"
                        sx={{
                          ml: 1,
                          color: BRAND.maroon,
                          textTransform: "none",
                          fontWeight: 600,
                          minWidth: "auto",
                          fontSize: "0.8rem",
                          "&:hover": { bgcolor: BRAND.maroonFaintHover },
                        }}
                        onClick={() => {
                          setFirstName(effectiveProfile?.first_name || "");
                          setLastName(effectiveProfile?.last_name || "");
                          setNameMessage("");
                          setEditMode(true);
                        }}
                      >
                        Edit
                      </Button>
                    </Box>
                  )}
                </Box>
                {nameMessage && (
                  <Alert
                    severity={nameMessage.includes("Error") ? "error" : "success"}
                    sx={{ mt: 1, borderRadius: 2 }}
                  >
                    {nameMessage}
                  </Alert>
                )}

                <Divider sx={{ my: 2.5, borderColor: BRAND.cardBorder }} />

                {/* -- Security -- */}
                <SectionLabel icon={LockOutlinedIcon}>Security</SectionLabel>
                {message && (
                  <Alert
                    severity={message.includes("Error") ? "error" : "success"}
                    sx={{ mb: 1.5, borderRadius: 2 }}
                  >
                    {message}
                  </Alert>
                )}
                <Button
                  variant="contained"
                  sx={{ ...btnMain, width: "100%" }}
                  onClick={handleChangePassword}
                >
                  Change Password
                </Button>

                {faceIdAvailable && (
                  <Box
                    sx={{
                      bgcolor: BRAND.maroonFaint,
                      borderRadius: 2,
                      px: 2,
                      py: 1.5,
                      mt: 2,
                    }}
                  >
                    <FormControlLabel
                      control={
                        <Switch
                          size="small"
                          checked={faceIdEnabled}
                          onChange={(e) => {
                            if (e.target.checked) setFaceIdPasswordDialog(true);
                            else handleDisableFaceId();
                          }}
                          sx={{
                            "& .MuiSwitch-switchBase.Mui-checked": { color: BRAND.maroon },
                            "& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track": { backgroundColor: BRAND.maroon },
                          }}
                        />
                      }
                      label={
                        <Box>
                          <Typography variant="body2" sx={{ fontWeight: 600, color: BRAND.textPrimary }}>Face ID Sign-in</Typography>
                          <Typography variant="caption" sx={{ color: BRAND.textSecondary }}>
                            {faceIdEnabled ? `Enabled for ${isDemoMode ? effectiveUser?.email : localStorage.getItem("biometric_email")}` : "Sign in with Face ID instead of typing your password"}
                          </Typography>
                        </Box>
                      }
                      labelPlacement="start"
                      sx={{ justifyContent: "space-between", ml: 0, width: "100%" }}
                    />
                  </Box>
                )}

                {/* -- Web Passkeys (Windows Hello / Touch ID) -- */}
                {isWeb && !isDemoMode && (
                  <Box
                    sx={{
                      bgcolor: BRAND.maroonFaint,
                      borderRadius: 2,
                      px: 2,
                      py: 1.5,
                      mt: 2,
                    }}
                  >
                    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: passkeys.length > 0 ? 1 : 0 }}>
                      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                        <FingerprintIcon sx={{ fontSize: 20, color: BRAND.maroon }} />
                        <Box>
                          <Typography variant="body2" sx={{ fontWeight: 600, color: BRAND.textPrimary }}>Fingerprint Sign-in</Typography>
                          <Typography variant="caption" sx={{ color: BRAND.textSecondary }}>
                            Sign in with Windows Hello or Touch ID
                          </Typography>
                        </Box>
                      </Box>
                      <Button
                        size="small"
                        variant="contained"
                        onClick={handleAddPasskey}
                        disabled={passkeyAdding || passkeysLoading}
                        sx={{
                          background: BRAND.maroon,
                          "&:hover": { background: BRAND.maroonDark },
                          fontWeight: 700,
                          borderRadius: 1.5,
                          textTransform: "none",
                          fontSize: 12,
                          px: 1.5,
                          flexShrink: 0,
                        }}
                      >
                        {passkeyAdding ? <CircularProgress size={12} color="inherit" /> : "Add"}
                      </Button>
                    </Box>

                    {passkeysLoading && (
                      <Box sx={{ display: "flex", justifyContent: "center", py: 1 }}>
                        <CircularProgress size={16} sx={{ color: BRAND.maroon }} />
                      </Box>
                    )}

                    {passkeys.map((pk) => (
                      <Box
                        key={pk.id}
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          py: 0.75,
                          borderTop: `1px solid ${BRAND.cardBorder}`,
                        }}
                      >
                        <Box>
                          <Typography variant="caption" sx={{ fontWeight: 600, color: BRAND.textPrimary, display: "block" }}>
                            {pk.device_name}
                          </Typography>
                          <Typography variant="caption" sx={{ color: BRAND.textSecondary }}>
                            Added {new Date(pk.created_at).toLocaleDateString()}
                            {pk.last_used_at ? ` · Last used ${new Date(pk.last_used_at).toLocaleDateString()}` : ""}
                          </Typography>
                        </Box>
                        <IconButton
                          size="small"
                          onClick={() => handleDeletePasskey(pk.id)}
                          sx={{ color: BRAND.textSecondary, "&:hover": { color: "error.main" } }}
                        >
                          <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                        </IconButton>
                      </Box>
                    ))}

                    {passkeyMessage && (
                      <Typography variant="caption" sx={{ display: "block", mt: 1, color: passkeyMessage.startsWith("Failed") ? "error.main" : (isDark ? "#4caf50" : "#2e7d32"), fontWeight: 600 }}>
                        {passkeyMessage}
                      </Typography>
                    )}
                  </Box>
                )}

                <Divider sx={{ my: 2.5, borderColor: BRAND.cardBorder }} />

                {/* -- Log Out / Exit Demo -- */}
                <SectionLabel icon={LogoutOutlinedIcon}>{isDemoMode ? "Exit Demo" : "Log Out"}</SectionLabel>
                <Button
                  variant="outlined"
                  sx={{ ...btnOutline, width: "100%" }}
                  onClick={isDemoMode ? exitDemo : async () => { await logout(); navigate("/"); }}
                  startIcon={<LogoutOutlinedIcon />}
                >
                  {isDemoMode ? "Exit Demo" : "Log Out"}
                </Button>
              </Box>

              {/* === RIGHT COLUMN: Appearance, Preferences, Danger Zone === */}
              <Box sx={{ display: "flex", flexDirection: "column" }}>
                {/* -- Appearance -- */}
                <SectionLabel icon={DarkModeOutlinedIcon}>Appearance</SectionLabel>
                <Box
                  sx={{
                    bgcolor: BRAND.maroonFaint,
                    borderRadius: 2,
                    px: 2,
                    py: 1.5,
                    mb: 2.5,
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{
                      color: BRAND.textSecondary,
                      fontWeight: 500,
                      mb: 0.75,
                      display: "block",
                    }}
                  >
                    Theme
                  </Typography>
                  <FormControl size="small" fullWidth>
                    <Select
                      value={themeMode}
                      onChange={(e) => setThemeMode(e.target.value)}
                      sx={{
                        bgcolor: BRAND.inputBg,
                        color: BRAND.textPrimary,
                        borderRadius: 2,
                        "& .MuiOutlinedInput-notchedOutline": {
                          borderColor: BRAND.cardBorder,
                        },
                        "&:hover .MuiOutlinedInput-notchedOutline": {
                          borderColor: BRAND.maroon,
                        },
                        "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
                          borderColor: BRAND.maroon,
                        },
                        "& .MuiSvgIcon-root": {
                          color: BRAND.textSecondary,
                        },
                      }}
                    >
                      <MenuItem value="auto">Device Default</MenuItem>
                      <MenuItem value="light">Light</MenuItem>
                      <MenuItem value="dark">Dark</MenuItem>
                    </Select>
                  </FormControl>
                  <Typography
                    variant="caption"
                    sx={{ color: BRAND.textSecondary, mt: 1, display: "block" }}
                  >
                    {themeMode === "auto"
                      ? `Following Device Default (${effectiveTheme} mode).`
                      : `Currently using ${effectiveTheme} mode.`}
                  </Typography>
                </Box>

                {/* -- Preferences -- */}
                <SectionLabel icon={LocationOnOutlinedIcon}>
                  Preferences
                </SectionLabel>
                <Box
                  sx={{
                    bgcolor: BRAND.maroonFaint,
                    borderRadius: 2,
                    px: 2,
                    py: 1.5,
                    mb: 1,
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{
                      color: BRAND.textSecondary,
                      fontWeight: 500,
                      mb: 0.75,
                      display: "block",
                    }}
                  >
                    Default campus
                  </Typography>
                  <FormControl size="small" fullWidth>
                    <Select
                      value={defaultCampus}
                      onChange={(e) => handleSaveCampus(e.target.value)}
                      displayEmpty
                      sx={{
                        bgcolor: BRAND.inputBg,
                        color: BRAND.textPrimary,
                        borderRadius: 2,
                        "& .MuiOutlinedInput-notchedOutline": {
                          borderColor: BRAND.cardBorder,
                        },
                        "&:hover .MuiOutlinedInput-notchedOutline": {
                          borderColor: BRAND.maroon,
                        },
                        "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
                          borderColor: BRAND.maroon,
                        },
                        "& .MuiSvgIcon-root": {
                          color: BRAND.textSecondary,
                        },
                      }}
                    >
                      {CAMPUSES.map((c) => (
                        <MenuItem key={c.id} value={c.id}>
                          {c.name}, {c.state}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Box>

                <Box
                  sx={{
                    bgcolor: BRAND.maroonFaint,
                    borderRadius: 2,
                    px: 2,
                    py: 1.5,
                    mb: 1,
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{
                      color: BRAND.textSecondary,
                      fontWeight: 500,
                      mb: 0.75,
                      display: "block",
                    }}
                  >
                    Time zone
                  </Typography>
                  <FormControl size="small" fullWidth>
                    <Select
                      value={timeZone}
                      onChange={(e) => setTimeZone(e.target.value)}
                      sx={{
                        bgcolor: BRAND.inputBg,
                        color: BRAND.textPrimary,
                        borderRadius: 2,
                        "& .MuiOutlinedInput-notchedOutline": {
                          borderColor: BRAND.cardBorder,
                        },
                        "&:hover .MuiOutlinedInput-notchedOutline": {
                          borderColor: BRAND.maroon,
                        },
                        "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
                          borderColor: BRAND.maroon,
                        },
                        "& .MuiSvgIcon-root": {
                          color: BRAND.textSecondary,
                        },
                      }}
                    >
                      {TIME_ZONE_OPTIONS.map((option) => (
                        <MenuItem key={option.value} value={option.value}>
                          {option.label} ({option.description})
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <Typography
                    variant="caption"
                    sx={{ color: BRAND.textSecondary, mt: 1, display: "block" }}
                  >
                    All listing, message, and moderation times follow this setting. Eastern Time is the default.
                  </Typography>
                </Box>
                {campusMessage && (
                  <Alert
                    severity={
                      campusMessage.includes("Error") ? "error" : "success"
                    }
                    sx={{ mt: 0.5, borderRadius: 2 }}
                  >
                    {campusMessage}
                  </Alert>
                )}

                <Divider sx={{ my: 2.5, borderColor: BRAND.cardBorder }} />

                {/* -- Notifications -- */}
                <SectionLabel icon={NotificationsOutlinedIcon}>Notifications</SectionLabel>
                <Box
                  sx={{
                    bgcolor: BRAND.maroonFaint,
                    borderRadius: 2,
                    px: 2,
                    py: 1.5,
                    mb: 2.5,
                    display: "flex",
                    flexDirection: "column",
                    gap: 1,
                  }}
                >
                  <FormControlLabel
                    control={
                      <Switch
                        size="small"
                        checked={notifEmail}
                        onChange={(e) => handleSaveNotif("emailNotifications", e.target.checked)}
                        sx={{
                          "& .MuiSwitch-switchBase.Mui-checked": { color: BRAND.maroon },
                          "& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track": { backgroundColor: BRAND.maroon },
                        }}
                      />
                    }
                    label={
                      <Box>
                        <Typography variant="body2" sx={{ fontWeight: 600, color: BRAND.textPrimary }}>Email digest</Typography>
                        <Typography variant="caption" sx={{ color: BRAND.textSecondary }}>Unread message reminder after 24h</Typography>
                      </Box>
                    }
                    labelPlacement="start"
                    sx={{ justifyContent: "space-between", ml: 0, width: "100%" }}
                  />
                  <FormControlLabel
                    control={
                      <Switch
                        size="small"
                        checked={notifPush}
                        onChange={(e) => handleSaveNotif("pushNotifications", e.target.checked)}
                        sx={{
                          "& .MuiSwitch-switchBase.Mui-checked": { color: BRAND.maroon },
                          "& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track": { backgroundColor: BRAND.maroon },
                        }}
                      />
                    }
                    label={
                      <Box>
                        <Typography variant="body2" sx={{ fontWeight: 600, color: BRAND.textPrimary }}>Message notifications</Typography>
                        <Typography variant="caption" sx={{ color: BRAND.textSecondary }}>New messages and support replies</Typography>
                      </Box>
                    }
                    labelPlacement="start"
                    sx={{ justifyContent: "space-between", ml: 0, width: "100%" }}
                  />
                  <FormControlLabel
                    control={
                      <Switch
                        size="small"
                        checked={notifBroadcast}
                        onChange={(e) => handleSaveNotif("broadcastNotifications", e.target.checked)}
                        sx={{
                          "& .MuiSwitch-switchBase.Mui-checked": { color: BRAND.maroon },
                          "& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track": { backgroundColor: BRAND.maroon },
                        }}
                      />
                    }
                    label={
                      <Box>
                        <Typography variant="body2" sx={{ fontWeight: 600, color: BRAND.textPrimary }}>Community updates</Typography>
                        <Typography variant="caption" sx={{ color: BRAND.textSecondary }}>Daily lost item broadcasts and announcements</Typography>
                      </Box>
                    }
                    labelPlacement="start"
                    sx={{ justifyContent: "space-between", ml: 0, width: "100%" }}
                  />
                </Box>

                <Divider sx={{ my: 2.5, borderColor: BRAND.cardBorder }} />

                {/* -- Blocked Users -- */}
                <Box
                  onClick={() => setBlockedOpen(o => !o)}
                  sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", mb: 1.5 }}
                >
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    <BlockIcon sx={{ fontSize: 18, color: BRAND.maroon, opacity: 0.7 }} />
                    <Typography variant="overline" sx={{ color: BRAND.textSecondary, letterSpacing: 1.5, fontWeight: 700, fontSize: "0.7rem" }}>
                      Blocked Users {blockedUsers.length > 0 && `(${blockedUsers.length})`}
                    </Typography>
                  </Box>
                  <Typography variant="caption" sx={{ color: BRAND.textSecondary, fontWeight: 600 }}>
                    {blockedOpen ? "▲" : "▼"}
                  </Typography>
                </Box>
                <Collapse in={blockedOpen}>
                  <Box sx={{ bgcolor: BRAND.maroonFaint, borderRadius: 2, px: 2, py: 1.5, mb: 2.5 }}>
                    {blockedUsers.length === 0 ? (
                      <Typography variant="body2" sx={{ color: BRAND.textSecondary }}>No blocked users.</Typography>
                    ) : (
                      <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
                        {blockedUsers.map(u => (
                          <Box key={u.id} sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                              <Avatar sx={{ width: 28, height: 28, bgcolor: BRAND.maroon, fontSize: 12, fontWeight: 700 }}>
                                {u.first_name?.[0]}{u.last_name?.[0]}
                              </Avatar>
                              <Typography variant="body2" fontWeight={600} sx={{ color: BRAND.textPrimary }}>
                                {u.first_name} {u.last_name}
                              </Typography>
                            </Box>
                            <Chip
                              label="Unblock"
                              size="small"
                              onClick={() => handleUnblockUser(u.id)}
                              sx={{ fontWeight: 700, fontSize: 11, cursor: "pointer", bgcolor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)", "&:hover": { bgcolor: isDark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.12)" } }}
                            />
                          </Box>
                        ))}
                      </Box>
                    )}
                  </Box>
                </Collapse>

                <Divider sx={{ my: 2.5, borderColor: BRAND.cardBorder }} />

                <SectionLabel icon={DeleteOutlineIcon} color="#d32f2f">
                  Danger Zone
                </SectionLabel>
                {deleteMessage && (
                  <Alert severity="error" sx={{ mb: 1.5, borderRadius: 2 }}>
                    {deleteMessage}
                  </Alert>
                )}
                <Button
                  variant="outlined"
                  color="error"
                  sx={{
                    width: "100%",
                    fontWeight: 600,
                    borderRadius: 2,
                    textTransform: "none",
                    py: 1,
                    fontSize: "0.9rem",
                  }}
                  onClick={() => setDeleteOpen(true)}
                >
                  Delete Account
                </Button>
              </Box>
            </Box>
          </Paper>
        </Container>
      </Box>

      {/* --- Face ID password dialog --- */}
      <Dialog
        open={faceIdPasswordDialog}
        onClose={() => { setFaceIdPasswordDialog(false); setFaceIdPassword(""); setFaceIdError(""); }}
        maxWidth="xs"
        fullWidth
        PaperProps={{ sx: { borderRadius: 3, px: 1 } }}
      >
        <DialogTitle sx={{ fontWeight: 700 }}>Enable Face ID</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Enter your password once to enable Face ID sign-in.
          </DialogContentText>
          <TextField
            autoFocus
            fullWidth
            size="small"
            type="password"
            label="Password"
            value={faceIdPassword}
            onChange={(e) => setFaceIdPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && faceIdPassword) { handleEnableFaceId(); dismissKeyboard(); } }}
            sx={{ "& .MuiOutlinedInput-root": { fontSize: { xs: 16, md: 13 } }, ...textFieldSx }}
          />
          {faceIdError && <Alert severity="error" sx={{ mt: 1.5, py: 0.5, borderRadius: 2 }}>{faceIdError}</Alert>}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            onClick={() => { setFaceIdPasswordDialog(false); setFaceIdPassword(""); setFaceIdError(""); }}
            sx={{ color: BRAND.textSecondary, textTransform: "none", fontWeight: 600 }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={!faceIdPassword || faceIdSaving}
            onClick={handleEnableFaceId}
            sx={{ ...btnMain, py: 0.5, px: 2.5 }}
          >
            {faceIdSaving ? <CircularProgress size={16} color="inherit" /> : "Enable"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* --- Delete confirmation dialog --- */}
      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        PaperProps={{
          sx: {
            borderRadius: 3,
            px: 1,
          },
        }}
      >
        <DialogTitle sx={{ fontWeight: 700 }}>
          Delete your account?
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            This action is permanent and cannot be undone. All your data will be
            removed. Are you sure you want to continue?
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            onClick={() => setDeleteOpen(false)}
            sx={{
              color: BRAND.textSecondary,
              textTransform: "none",
              fontWeight: 600,
            }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={handleDeleteAccount}
            sx={{
              fontWeight: 600,
              borderRadius: 2,
              textTransform: "none",
              boxShadow: "none",
            }}
          >
            Yes, Delete My Account
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}