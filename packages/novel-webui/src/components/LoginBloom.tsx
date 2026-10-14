import type { CSSProperties } from "react";

type PetalRing = {
  count: number;
  delay: number;
  length: number;
  radius: number;
  width: number;
};

const PETAL_RINGS: PetalRing[] = [
  { count: 16, delay: 0.08, length: 142, radius: 25, width: 42 },
  { count: 12, delay: 0.42, length: 105, radius: 17, width: 35 },
  { count: 8, delay: 0.72, length: 70, radius: 10, width: 27 },
];

type PetalStyle = CSSProperties & {
  "--petal-angle": string;
  "--petal-delay": string;
};

function petalPath({ length, radius, width }: PetalRing) {
  const baseY = 320 - radius;
  const tipY = baseY - length;
  const shoulderY = baseY - length * 0.56;
  return [
    `M 320 ${baseY}`,
    `C ${320 - width * 0.92} ${baseY - length * 0.18}, ${320 - width} ${shoulderY}, 320 ${tipY}`,
    `C ${320 + width} ${shoulderY}, ${320 + width * 0.92} ${baseY - length * 0.18}, 320 ${baseY}`,
    "Z",
  ].join(" ");
}

export function LoginBloom() {
  return (
    <div aria-hidden="true" className="login-bloom">
      <svg viewBox="0 0 640 640">
        <defs>
          <linearGradient id="login-bloom-petal" x1="0" x2="0" y1="1" y2="0">
            <stop offset="0" stopColor="var(--bloom-petal-deep)" />
            <stop offset=".58" stopColor="var(--bloom-petal-mid)" />
            <stop offset="1" stopColor="var(--bloom-petal-tip)" />
          </linearGradient>
          <radialGradient id="login-bloom-heart">
            <stop offset="0" stopColor="var(--bloom-heart-light)" />
            <stop offset=".45" stopColor="var(--bloom-heart-mid)" />
            <stop offset="1" stopColor="var(--bloom-heart-deep)" />
          </radialGradient>
        </defs>

        <path className="login-bloom-stem" d="M326 618C314 525 344 444 320 320" />

        {PETAL_RINGS.map((ring, ringIndex) =>
          Array.from({ length: ring.count }, (_, petalIndex) => {
            const angle = petalIndex * (360 / ring.count) + ringIndex * 11.25;
            const style: PetalStyle = {
              "--petal-angle": `${angle}deg`,
              "--petal-delay": `${ring.delay + petalIndex * 0.022}s`,
            };

            return (
              <g
                className={`login-bloom-petal login-bloom-petal-${ringIndex + 1}`}
                key={`${ringIndex}-${petalIndex}`}
                style={style}
              >
                <path d={petalPath(ring)} fill="url(#login-bloom-petal)" />
              </g>
            );
          }),
        )}

        <circle className="login-bloom-heart" cx="320" cy="320" fill="url(#login-bloom-heart)" r="27" />
        <g className="login-bloom-stamens">
          {Array.from({ length: 12 }, (_, index) => {
            const angle = index * 30;
            return <circle cx="320" cy="296" key={angle} r="2.8" transform={`rotate(${angle} 320 320)`} />;
          })}
        </g>
      </svg>
    </div>
  );
}
