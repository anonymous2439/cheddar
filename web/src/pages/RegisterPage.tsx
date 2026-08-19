import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import axios from "axios";

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ username: "", email: "", password: "", display_name: "" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function update(field: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [field]: e.target.value });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await register(form);
      navigate("/");
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        setError("Username or email already in use");
      } else {
        setError("Registration failed. Check your details and try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-neutral-50 px-4 py-8">
      <form onSubmit={handleSubmit} className="w-full max-w-80 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
        <h1 className="mb-6 text-xl font-semibold text-neutral-900">Create your Cheddar account</h1>

        <label htmlFor="display_name" className="mb-1 block text-sm text-neutral-600">Display name</label>
        <input
          id="display_name"
          className="mb-4 w-full rounded border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-amber-500"
          value={form.display_name}
          onChange={update("display_name")}
          required
        />

        <label htmlFor="username" className="mb-1 block text-sm text-neutral-600">Username</label>
        <input
          id="username"
          className="mb-4 w-full rounded border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-amber-500"
          value={form.username}
          onChange={update("username")}
          pattern="^[a-zA-Z0-9_]+$"
          minLength={3}
          required
        />

        <label htmlFor="email" className="mb-1 block text-sm text-neutral-600">Email</label>
        <input
          id="email"
          type="email"
          className="mb-4 w-full rounded border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-amber-500"
          value={form.email}
          onChange={update("email")}
          required
        />

        <label htmlFor="password" className="mb-1 block text-sm text-neutral-600">Password</label>
        <input
          id="password"
          type="password"
          className="mb-4 w-full rounded border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-amber-500"
          value={form.password}
          onChange={update("password")}
          minLength={8}
          required
        />

        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-amber-500 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
        >
          {submitting ? "Creating account..." : "Create account"}
        </button>

        <p className="mt-4 text-center text-sm text-neutral-600">
          Already have an account?{" "}
          <Link to="/login" className="text-amber-600 hover:underline">
            Log in
          </Link>
        </p>
      </form>
    </div>
  );
}
