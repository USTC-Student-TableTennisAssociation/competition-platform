export default function ClosedPage() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-2xl flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-3xl font-bold text-white">网站维护中</h1>
      <p className="text-sm text-slate-300">
        当前站点暂时关闭维护，请稍后再访问。
      </p>
    </div>
  );
}
