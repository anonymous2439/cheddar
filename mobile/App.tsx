import { ActivityIndicator, StyleSheet, View } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { AuthProvider, useAuth } from "./src/context/AuthContext";
import { WebSocketProvider } from "./src/context/WebSocketContext";
import { ChatDataProvider } from "./src/context/ChatDataContext";
import { LoginScreen } from "./src/screens/LoginScreen";
import { RegisterScreen } from "./src/screens/RegisterScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { ChatScreen } from "./src/screens/ChatScreen";
import type { Conversation } from "./src/types";

export type RootStackParamList = {
  Login: undefined;
  Register: undefined;
  Home: undefined;
  ChatDetail: { conversation: Conversation };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

function RootNavigator() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color="#f59e0b" />
      </View>
    );
  }

  return (
    <Stack.Navigator screenOptions={{ headerTintColor: "#f59e0b" }}>
      {user ? (
        <>
          <Stack.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
          <Stack.Screen name="ChatDetail" component={ChatScreen} options={{ headerBackTitle: "Back" }} />
        </>
      ) : (
        <>
          <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Register" component={RegisterScreen} options={{ headerShown: false }} />
        </>
      )}
    </Stack.Navigator>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <WebSocketProvider>
          <ChatDataProvider>
            <NavigationContainer>
              <RootNavigator />
            </NavigationContainer>
          </ChatDataProvider>
        </WebSocketProvider>
      </AuthProvider>
      <StatusBar style="auto" />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#fff" },
});
