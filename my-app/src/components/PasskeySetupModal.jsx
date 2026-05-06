import { useState } from "react";
import {
  Dialog, DialogContent, Box, Typography, Button, CircularProgress,
} from "@mui/material";
import FingerprintIcon from "@mui/icons-material/Fingerprint";
import { startRegistration } from "@simplewebauthn/browser";
import apiFetch from "../utils/apiFetch";

export default function PasskeySetupModal({ open, onDone, isDark, userId, userEmail }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const markPrompted = () => {
    if (userId) localStorage.setItem(`passkey_prompted_${userId}`, "1");
  };

  const handleEnable = async () => {
    setLoading(true);
    setError("");
    try {
      const options = await apiFetch("/api/passkeys/register/options", { method: "POST" });
      const attResp = await startRegistration({ optionsJSON: options });
      await apiFetch("/api/passkeys/register/verify", {
        method: "POST",
        body: JSON.stringify({ response: attResp }),
      });
      if (userEmail) localStorage.setItem("passkey_email", userEmail);
      markPrompted();
      setSuccess(true);
      setTimeout(() => onDone(), 1400);
    } catch (err) {
      if (err?.name === "NotAllowedError") {
        setError("Setup was cancelled. You can enable this later in Settings.");
      } else {
        setError(err?.message || "Setup failed. You can try again in Settings.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSkip = () => {
    markPrompted();
    onDone();
  };

  return (
    <Dialog
      open={open}
      maxWidth="xs"
      fullWidth
      PaperProps={{
        sx: {
          borderRadius: 3,
          background: isDark ? "#1A1A1B" : "#fff",
          border: isDark ? "1px solid rgba(255,255,255,0.1)" : "1px solid #ecdcdc",
          m: 2,
        },
      }}
    >
      <DialogContent sx={{ p: { xs: 2.5, sm: 3 } }}>
        <Box sx={{ textAlign: "center", mb: 2.5 }}>
          <Box
            sx={{
              width: 60,
              height: 60,
              borderRadius: "50%",
              background: isDark ? "rgba(255,69,0,0.13)" : "rgba(168,77,72,0.09)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              mx: "auto",
              mb: 1.5,
            }}
          >
            <FingerprintIcon sx={{ fontSize: 32, color: isDark ? "#FF4500" : "#A84D48" }} />
          </Box>
          <Typography sx={{ fontWeight: 800, fontSize: 18, color: isDark ? "#D7DADC" : "#1a1a1a", lineHeight: 1.3, mb: 0.75 }}>
            Sign in faster with your fingerprint
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
            Use Windows Hello or Touch ID to sign in without typing your password.
            Your fingerprint never leaves your device.
          </Typography>
        </Box>

        {error && (
          <Typography variant="caption" sx={{ display: "block", color: "error.main", textAlign: "center", mb: 1.5, px: 1 }}>
            {error}
          </Typography>
        )}

        {success ? (
          <Box sx={{ textAlign: "center", py: 1 }}>
            <Typography variant="body2" sx={{ color: isDark ? "#4caf50" : "#2e7d32", fontWeight: 700 }}>
              Passkey set up successfully!
            </Typography>
          </Box>
        ) : (
          <>
            <Button
              fullWidth
              variant="contained"
              onClick={handleEnable}
              disabled={loading}
              startIcon={loading ? null : <FingerprintIcon />}
              sx={{
                background: isDark ? "#FF4500" : "#A84D48",
                "&:hover": { background: isDark ? "#E03D00" : "#8a3d39" },
                fontWeight: 700,
                borderRadius: 2,
                py: 1,
                mb: 1.25,
                textTransform: "none",
                fontSize: 14,
              }}
            >
              {loading ? <CircularProgress size={16} color="inherit" /> : "Enable fingerprint sign-in"}
            </Button>

            <Box sx={{ textAlign: "center" }}>
              <Typography
                component="span"
                variant="caption"
                onClick={!loading ? handleSkip : undefined}
                sx={{
                  color: "text.disabled",
                  cursor: loading ? "default" : "pointer",
                  fontSize: 12,
                  "&:hover": { color: "text.secondary" },
                }}
              >
                Not now
              </Typography>
            </Box>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
