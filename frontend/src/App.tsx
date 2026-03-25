import { Routes, Route } from 'react-router-dom'
import Nav from './components/Nav'
import Home from './pages/Home'
import ProductDetail from './pages/ProductDetail'
import BarcodeScanner from './components/BarcodeScanner'
import SplashScreen from './components/SplashScreen'

export default function App() {
  return (
    <div className="mx-auto min-h-screen max-w-lg bg-gray-50">
      <SplashScreen />
      <Nav />
      <div className="pb-20">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/product/:id" element={<ProductDetail />} />
        </Routes>
      </div>
      <BarcodeScanner />
    </div>
  )
}
