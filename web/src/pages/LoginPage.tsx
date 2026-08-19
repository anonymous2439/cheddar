import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(identifier, password);
      navigate("/");
    } catch {
      setError("Invalid username/email or password");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-neutral-50 px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-80 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
        <h1 className="mb-6 text-xl font-semibold text-neutral-900">Log in to Cheddar</h1>

        <label htmlFor="identifier" className="mb-1 block text-sm text-neutral-600">Username or email</label>
        <input
          id="identifier"
          className="mb-4 w-full rounded border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-amber-500"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          required
        />

        <label htmlFor="password" className="mb-1 block text-sm text-neutral-600">Password</label>
        <input
          id="password"
          type="password"
          className="mb-4 w-full rounded border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-amber-500"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-amber-500 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
        >
          {submitting ? "Logging in..." : "Log in"}
        </button>

        <p className="mt-4 text-center text-sm text-neutral-600">
          No account?{" "}
          <Link to="/register" className="text-amber-600 hover:underline">
            Register
          </Link>
        </p>
      </form>
    </div>
  );
}
