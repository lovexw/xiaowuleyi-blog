// 主题 CSS 以纯文本导入（wrangler rules: Text）
declare module '*.css' {
  const css: string
  export default css
}

// schema.sql 以纯文本导入（wrangler rules 以 text 加载，冷启动建表与测试建库用）
declare module '*.sql' {
  const sql: string
  export default sql
}
