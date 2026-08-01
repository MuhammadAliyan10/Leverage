/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        primary: "#533AFE",
      },
      fontFamily: {
        fargie: ["Fargie", "Inter", "sans-serif"],
      },
    },
  },
  plugins: [],
};
