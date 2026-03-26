import Disclaimer from '../components/Disclaimer'

export default function Home() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <Disclaimer />
      <div className="flex flex-1 items-center justify-center py-16">
        <img src="/favicon.svg" alt="CocoNot" className="h-32 w-32 opacity-20" />
      </div>
    </div>
  )
}
