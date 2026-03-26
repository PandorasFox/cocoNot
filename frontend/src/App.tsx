import Nav from './components/Nav'
import Home from './pages/Home'
import BarcodeScanner from './components/BarcodeScanner'
import SplashScreen from './components/SplashScreen'

export default function App() {
  return (
    <div className="mx-auto min-h-screen max-w-lg bg-gray-50">
      <SplashScreen />
      <Nav />
      <div className="pb-20">
        <Home />
      </div>
      <BarcodeScanner />
    </div>
  )
}
