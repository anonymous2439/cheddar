import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useAuth } from "../context/AuthContext";
import type { RootStackParamList } from "../../App";

type Props = NativeStackScreenProps<RootStackParamList, "Login">;

export function LoginScreen({ navigation }: Props) {
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      await login(identifier, password);
    } catch {
      setError("Invalid username/email or password");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.card}>
        <Text style={styles.title}>Log in to Cheddar</Text>

        <Text style={styles.label}>Username or email</Text>
        <TextInput
          style={styles.input}
          value={identifier}
          onChangeText={setIdentifier}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={styles.label}>Password</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
        />

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable
          style={[styles.button, submitting && styles.buttonDisabled]}
          onPress={handleSubmit}
          disabled={submitting}
        >
          <Text style={styles.buttonText}>{submitting ? "Logging in..." : "Log in"}</Text>
        </Pressable>

        <Pressable style={styles.linkRow} onPress={() => navigation.navigate("Register")}>
          <Text style={styles.linkText}>
            No account? <Text style={styles.link}>Register</Text>
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#fafafa", padding: 16 },
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
    color: "#171717",
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
