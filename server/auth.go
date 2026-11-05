package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"time"
)

const (
	authCookieName   = "bs_auth"
	authCookieMaxAge = 30 * 24 * 60 * 60 // 30 天
	authHMACMessage  = "bigscreen-auth-v1"
)

// Auth 负责可选的编辑鉴权：服务端启动时随机密钥做 HMAC-SHA256 Cookie。
// 重启后密钥变化，旧 Cookie 自动失效，需要重新登录。
type Auth struct {
	enabled  bool
	password string
	token    string
}

// NewAuth 创建鉴权器；password 为空表示不鉴权。
func NewAuth(password string) *Auth {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		// 极端情况下 rand 不可用，用时间戳兜底，至少不会产生固定 Cookie。
		now := time.Now().UnixNano()
		for i := range secret {
			secret[i] = byte(now >> (uint(i%8) * 8))
		}
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(authHMACMessage))
	return &Auth{
		enabled:  password != "",
		password: password,
		token:    hex.EncodeToString(mac.Sum(nil)),
	}
}

// Enabled 是否需要登录。
func (a *Auth) Enabled() bool { return a.enabled }

// Authenticated 判断请求是否已通过鉴权（未启用密码时恒为 true）。
func (a *Auth) Authenticated(r *http.Request) bool {
	if !a.enabled {
		return true
	}
	c, err := r.Cookie(authCookieName)
	if err != nil || c.Value == "" {
		return false
	}
	return hmac.Equal([]byte(c.Value), []byte(a.token))
}

// CheckPassword 常量时间比较密码。
func (a *Auth) CheckPassword(password string) bool {
	return subtle.ConstantTimeCompare([]byte(password), []byte(a.password)) == 1
}

// Require 包裹需要登录的处理器；未登录返回 401（不重定向，前端自行弹登录框）。
func (a *Auth) Require(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.Authenticated(r) {
			writeErrorJSON(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next(w, r)
	}
}

// SetCookie 写入登录 Cookie（HttpOnly / SameSite=Lax / 30 天）。
func (a *Auth) SetCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     authCookieName,
		Value:    a.token,
		Path:     "/",
		MaxAge:   authCookieMaxAge,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil,
	})
}

// ClearCookie 清除登录 Cookie。
func (a *Auth) ClearCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     authCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		Expires:  time.Unix(0, 0),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil,
	})
}
