import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import './theme.css'
import './hero.css'
// 这是网页界面的唯一启动入口：把 React 应用挂到 index.html 中名为 root 的空容器。
// StrictMode 只在开发阶段帮助发现不安全的副作用，不会改变打包后用户看到的功能。
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>)
