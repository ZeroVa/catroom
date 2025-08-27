import { useCallback, useState } from 'react'
import './App.css'
import { usePspspsDetector } from './pspsps-detector'

/**
 * Tiny cat overlay for demo 🐈
 */
type Cat = { id: number; x: number; y: number; rot: number; size: number };

function CatsOverlay({ cats }: { cats: Cat[] }) {
 return (
   <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none' }}>
     {cats.map(c => (
       <div key={c.id}
            style={{
              position: 'absolute',
              left: `${c.x}%`, top: `${c.y}%`, transform: `translate(-50%, -50%) rotate(${c.rot}deg)`,
              fontSize: `${c.size}px`, filter: 'drop-shadow(0 6px 12px rgba(0,0,0,.35))',
              animation: 'floaty 2.2s ease-out forwards',
            }}>
         🐈‍⬛
       </div>
     ))}
     <style>{`
       @keyframes floaty { from { transform: translate(-50%,-50%) translateY(16px); opacity: 0 } to { transform: translate(-50%,-50%) translateY(-6px); opacity: 1 } }
     `}</style>
   </div>
 );
}

/**
* Demo App
*/
export default function App() {
 const [cats, setCats] = useState<Cat[]>([]);
 const [sensitivity, setSensitivity] = useState(1.0);
 const [debug, setDebug] = useState(true);
 
 const onDetect = useCallback(() => {
   // Drop 3 cats at random spots
   setCats(prev => [
     ...prev,
     ...Array.from({ length: 3 }).map((_, i) => ({
       id: Date.now() + i,
       x: Math.random() * 90 + 5,
       y: Math.random() * 70 + 10,
       rot: (Math.random() - 0.5) * 40,
       size: Math.random() * 24 + 32,
     }))
   ]);
   // Auto-cleanup older cats
   setTimeout(() => setCats(prev => prev.slice(-30)), 2500);
 }, []);

 const { start, stop, listening, error } = usePspspsDetector(onDetect, {
   debug,
   sensitivity,
 });

 return (
   <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-white text-black p-6">
     <h1 className="text-3xl font-semibold">PSPSPS Detector (React)</h1>
     <p className="opacity-80 max-w-prose text-center">
       Click <b>Start Listening</b>, then make quick hissy bursts like “ps-ps-ps.” When detected, cats appear. The
       floating debug card shows high-band energy and bursts. Tweak sensitivity if it’s too shy or too eager.
     </p>

     <div className="flex items-center gap-3">
       {!listening ? (
         <button onClick={start}
           className="px-4 py-2 rounded-xl bg-cyan-500/90 hover:bg-cyan-400 text-black font-medium shadow">
           Start Listening
         </button>
       ) : (
         <button onClick={stop}
           className="px-4 py-2 rounded-xl bg-pink-500/90 hover:bg-pink-400 text-black font-medium shadow">
           Stop Listening
         </button>
       )}

       <label className="flex items-center gap-2 bg-white/5 px-3 py-2 rounded-lg">
         <span className="opacity-80">Debug</span>
         <input type="checkbox" checked={debug} onChange={e => setDebug(e.target.checked)} />
       </label>
     </div>

     <div className="w-full max-w-md bg-white/5 rounded-xl p-4 flex flex-col gap-2">
       <label className="text-sm opacity-80">Sensitivity ({sensitivity.toFixed(2)})</label>
       <input type="range" min={0.5} max={2.0} step={0.05} value={sensitivity}
              onChange={e => setSensitivity(parseFloat(e.target.value))} />
       <div className="text-xs opacity-70">
         Lower ⟶ stricter (fewer detections). Higher ⟶ looser (more detections).
       </div>
     </div>

     {error && (
       <div className="text-red-300 bg-red-900/30 border border-red-800 px-3 py-2 rounded">{error}</div>
     )}

     <CatsOverlay cats={cats} />
   </div>
 );
}
