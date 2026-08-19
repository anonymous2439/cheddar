import { useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import axios from "axios";
import { useAuth } from "../context/AuthContext";
import type { RootStackParamList } from "../../App";

type Props = NativeStackScreenProps<RootStackParamList, "Register">;

export function RegisterScreen({ navigation }: Props) {
  const { register } = useAuth();
  const [form, setForm] = useState({ username: "", email: "", password: "", display_name: "" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function update(field: keyof typeof form) {
    return (value: string) => setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      await register(form);
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
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.card}>
          <Text style={styles.title}>Create your Cheddar account</Text>

          <Text style={styles.label}>Display name</Text>
          <TextInput
            style={styles.input}
            value={form.display_name}
            onChangeText={update("display_name")}
          />

          <Text style={styles.label}>Username</Text>
          <TextInput
            style={styles.input}
            value={form.username}
            onChangeText={update("username")}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            value={form.email}
            onChangeText={update("email")}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            value={form.password}
            onChangeText={update("password")}
            secureTextEntry
            autoCapitalize="none"
          />

          {error && <Text style={styles.error}>{error}</Text>}

          <Pressable
            style={[styles.button, submitting && styles.buttonDisabled]}
            onPress={handleSubmit}
            disabled={submitting}
          >
            <Text style={styles.buttonText}>{submitting ? "Creating account..." : "Create account"}</Text>
          </Pressable>

          <Pressable style={styles.linkRow} onPress={() => navigation.navigate("Login")}>
            <Text style={styles.linkText}>
              Already have an account? <Text style={styles.link}>Log in</Text>
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#fafafa" },
  scrollContent: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 16 },
  card: {
    width: "100%",
    maxWidth: 340,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e5e5e5",
    backgroundColor: "#fff",
    padding: 24,
  },
  title: { fontSize: 20, fontWeight: "600", color: "#171717", marginBottom: 24 },
  label: { fontSize: 13, color: "#525252", marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: "#d4d4d4",
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    marginBottom: 16,
  },
  error: { color: "#dc2626", fontSize: 13, marginBottom: 12 },
  button: { backgroundColor: "#f59e0b", borderRadius: 6, paddingVertical: 10, alignItems: "center" },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  linkRow: { marginTop: 16, alignItems: "center" },
  linkText: { fontSize: 13, color: "#525252" },
  link: { color: "#d97706", fontWeight: "500" },
});
