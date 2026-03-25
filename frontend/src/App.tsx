import { Routes, Route } from 'react-router-dom'
import Nav from './components/Nav'
import Home from './pages/Home'
import ProductDetail from './pages/ProductDetail'
import Reclassified from './pages/Reclassified'
import BarcodeScanner from './components/BarcodeScanner'

export default function App() {
  return (
    <div className="mx-auto min-h-screen max-w-lg bg-gray-50">
      <Nav />
      <div className="pb-20">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/product/:id" element={<ProductDetail />} />
          <Route path="/reclassified" element={<Reclassified />} />
        </Routes>
      </div>
      <BarcodeScanner />
    </div>
  )
}
