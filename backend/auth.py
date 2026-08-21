"""
auth.py — OTP generation, Gmail SMTP email sending, and in-memory OTP store.
"""
import os
import random
import smtplib
import hashlib
import time
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from dotenv import load_dotenv

load_dotenv()

# In-memory OTP store: { email: { "code": "123456", "expires_at": timestamp, "user_id": int } }
_otp_store: dict = {}
OTP_TTL_SECONDS = 600  # 10 minutes


# ---------------------------------------------------------------------------
# Password hashing (no extra library needed — uses SHA-256 + salt)
# ---------------------------------------------------------------------------

def hash_password(password: str) -> str:
    salt = os.urandom(16).hex()
    hashed = hashlib.sha256((salt + password).encode()).hexdigest()
    return f"{salt}:{hashed}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        salt, hashed = stored_hash.split(":", 1)
        return hashlib.sha256((salt + password).encode()).hexdigest() == hashed
    except Exception:
        return False


# ---------------------------------------------------------------------------
# OTP generation and store management
# ---------------------------------------------------------------------------

def generate_otp() -> str:
    """Generate a secure 6-digit OTP code."""
    return str(random.SystemRandom().randint(100000, 999999))


def store_otp(email: str, user_id: int) -> str:
    """Generate and store an OTP for the given email. Returns the OTP code."""
    code = generate_otp()
    _otp_store[email.lower()] = {
        "code": code,
        "expires_at": time.time() + OTP_TTL_SECONDS,
        "user_id": user_id
    }
    return code


def verify_otp(email: str, code: str) -> tuple[bool, int | None]:
    """
    Verify OTP. Returns (success: bool, user_id: int | None).
    Clears the OTP from store on success.
    """
    email = email.lower()
    entry = _otp_store.get(email)
    if not entry:
        return False, None
    if time.time() > entry["expires_at"]:
        _otp_store.pop(email, None)
        return False, None
    if entry["code"] != code.strip():
        return False, None
    # Valid — clear from store
    user_id = entry["user_id"]
    _otp_store.pop(email, None)
    return True, user_id


# ---------------------------------------------------------------------------
# Gmail SMTP email sender
# ---------------------------------------------------------------------------

def send_otp_email(to_email: str, otp_code: str, username: str = "") -> bool:
    """
    Send an OTP verification email via Gmail SMTP.
    Requires EMAIL_SENDER and EMAIL_APP_PASSWORD in .env.
    Returns True on success, False on failure.
    """
    sender = os.environ.get("EMAIL_SENDER", "").strip()
    app_password = os.environ.get("EMAIL_APP_PASSWORD", "").strip()

    if not sender or not app_password:
        # No email config — print OTP to console for dev mode
        print(f"\n{'='*50}")
        print(f"[DEV MODE] OTP for {to_email}: {otp_code}")
        print(f"(Set EMAIL_SENDER and EMAIL_APP_PASSWORD in .env to send real emails)")
        print(f"{'='*50}\n")
        return True  # Treat as success in dev mode

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = "🔐 Orbit Terminal — Your Verification Code"
        msg["From"] = f"Orbit Systems <{sender}>"
        msg["To"] = to_email

        # HTML email body
        html = f"""
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {{ background: #0a0a1a; font-family: Inter, sans-serif; margin: 0; padding: 40px 20px; }}
    .card {{ max-width: 480px; margin: 0 auto; background: #12122a; border: 1px solid rgba(0,240,255,0.2); border-radius: 16px; padding: 40px; text-align: center; }}
    .logo {{ font-size: 32px; margin-bottom: 8px; }}
    h1 {{ color: #00f0ff; font-size: 22px; margin: 0 0 8px; }}
    p {{ color: #8b8fa8; margin: 0 0 24px; font-size: 14px; }}
    .otp {{ font-size: 42px; font-weight: 700; letter-spacing: 12px; color: #ffffff; background: rgba(0,240,255,0.1); border: 1px solid rgba(0,240,255,0.3); border-radius: 12px; padding: 20px 32px; display: inline-block; margin: 8px 0; font-family: monospace; }}
    .note {{ font-size: 12px; color: #555; margin-top: 20px; }}
    .brand {{ color: #00f0ff; font-weight: 700; }}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">⚡</div>
    <h1>Verify your account</h1>
    <p>Hi <strong style="color:#fff">{username or to_email}</strong>! Enter this code in the terminal to activate your account.</p>
    <div class="otp">{otp_code}</div>
    <p style="margin-top:16px;">This code expires in <strong style="color:#fff">10 minutes</strong>.</p>
    <p class="note">If you didn't sign up for <span class="brand">Orbit Trading Terminal</span>, ignore this email.</p>
  </div>
</body>
</html>
"""
        plain = f"Your Orbit Terminal verification code is: {otp_code}\nExpires in 10 minutes."

        msg.attach(MIMEText(plain, "plain"))
        msg.attach(MIMEText(html, "html"))

        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(sender, app_password)
            server.sendmail(sender, to_email, msg.as_string())

        print(f"[AUTH] OTP email sent to {to_email}")
        return True

    except Exception as e:
        print(f"[AUTH] Email send failed: {e}")
        return False
