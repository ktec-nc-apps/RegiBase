<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

use OCP\IL10N;

class Templates {
	/**
	 * Built-in collection templates. Names, descriptions, field labels and
	 * Japanese select-options are translated through IL10N (source language =
	 * Japanese; translations live in l10n/<lang>.json). Field 'key' values stay
	 * as stable English identifiers and are never translated.
	 * @return array<int,array>
	 */
	public static function all(IL10N $l): array {
		$t = static fn (string $s): string => $l->t($s);
		return [
			[
				'key' => 'credit_card', 'name' => $t('クレジットカード'), 'icon' => '💳', 'color' => '#6366f1',
				'description' => $t('カード番号・有効期限・セキュリティコードなど'),
				'fields' => [
					['key' => 'card_name', 'label' => $t('カード名称'), 'type' => 'text', 'is_title' => true, 'required' => true, 'placeholder' => $t('楽天カード など')],
					['key' => 'brand', 'label' => $t('ブランド'), 'type' => 'select', 'options' => ['Visa', 'Mastercard', 'JCB', 'American Express', 'Diners', $t('その他')]],
					['key' => 'number', 'label' => $t('カード番号'), 'type' => 'text', 'secret' => true, 'placeholder' => '4111111111111111', 'options' => ['charset' => 'digits', 'max' => 19]],
					['key' => 'holder', 'label' => $t('名義人'), 'type' => 'text', 'options' => ['charset' => 'alpha', 'max' => 40]],
					['key' => 'expiry', 'label' => $t('有効期限'), 'type' => 'month'],
					['key' => 'cvc', 'label' => $t('セキュリティコード'), 'type' => 'text', 'secret' => true, 'options' => ['charset' => 'digits', 'min' => 3, 'max' => 4]],
					['key' => 'pin', 'label' => $t('暗証番号'), 'type' => 'password', 'secret' => true, 'options' => ['charset' => 'digits', 'min' => 4, 'max' => 6]],
					['key' => 'issuer', 'label' => $t('カード会社'), 'type' => 'text'],
					['key' => 'support_tel', 'label' => $t('サポート電話'), 'type' => 'tel', 'options' => ['charset' => 'phone', 'max' => 20]],
					['key' => 'memo', 'label' => $t('メモ'), 'type' => 'textarea'],
				],
			],
			[
				'key' => 'bank_account', 'name' => $t('銀行口座'), 'icon' => '🏦', 'color' => '#059669',
				'description' => $t('銀行名・支店・口座番号・ネットバンキング'),
				'fields' => [
					['key' => 'bank_name', 'label' => $t('銀行名'), 'type' => 'text', 'is_title' => true, 'required' => true],
					['key' => 'branch', 'label' => $t('支店名'), 'type' => 'text'],
					['key' => 'account_type', 'label' => $t('種別'), 'type' => 'select', 'options' => [$t('普通'), $t('当座'), $t('貯蓄'), $t('その他')]],
					['key' => 'account_number', 'label' => $t('口座番号'), 'type' => 'text', 'options' => ['charset' => 'digits', 'max' => 10]],
					['key' => 'holder', 'label' => $t('口座名義'), 'type' => 'text'],
					['key' => 'login_id', 'label' => $t('ログインID'), 'type' => 'text'],
					['key' => 'login_password', 'label' => $t('ログインパスワード'), 'type' => 'password', 'secret' => true],
					['key' => 'pin', 'label' => $t('暗証番号'), 'type' => 'password', 'secret' => true, 'options' => ['charset' => 'digits', 'min' => 4, 'max' => 4]],
					['key' => 'memo', 'label' => $t('メモ'), 'type' => 'textarea'],
				],
			],
			[
				'key' => 'online_account', 'name' => $t('オンライン登録'), 'icon' => '🔐', 'color' => '#2563eb',
				'description' => $t('Webサービスのユーザー登録（ID/パスワード）'),
				'fields' => [
					['key' => 'service', 'label' => $t('サービス名'), 'type' => 'text', 'is_title' => true, 'required' => true],
					['key' => 'url', 'label' => 'URL', 'type' => 'url', 'placeholder' => 'https://'],
					['key' => 'username', 'label' => $t('ユーザー名 / ID'), 'type' => 'text'],
					['key' => 'email', 'label' => $t('メールアドレス'), 'type' => 'email'],
					['key' => 'password', 'label' => $t('パスワード'), 'type' => 'password', 'secret' => true],
					['key' => 'otp', 'label' => $t('二段階認証 / リカバリコード'), 'type' => 'textarea', 'secret' => true],
					['key' => 'category', 'label' => $t('カテゴリ'), 'type' => 'text'],
					['key' => 'memo', 'label' => $t('メモ'), 'type' => 'textarea'],
				],
			],
			[
				'key' => 'membership_id', 'name' => $t('会員証・ID'), 'icon' => '🪪', 'color' => '#d97706',
				'description' => $t('会員番号・各種ID・証明書番号'),
				'fields' => [
					['key' => 'name', 'label' => $t('名称'), 'type' => 'text', 'is_title' => true, 'required' => true],
					['key' => 'number', 'label' => $t('番号'), 'type' => 'text', 'secret' => true],
					['key' => 'holder', 'label' => $t('名義人'), 'type' => 'text'],
					['key' => 'issued', 'label' => $t('発行日'), 'type' => 'date'],
					['key' => 'expiry', 'label' => $t('有効期限'), 'type' => 'date'],
					['key' => 'memo', 'label' => $t('メモ'), 'type' => 'textarea'],
				],
			],
			[
				'key' => 'software_license', 'name' => $t('ライセンス管理'), 'icon' => '🔑', 'color' => '#7c3aed',
				'description' => $t('ソフトウェアのライセンスキー・購入情報'),
				'fields' => [
					['key' => 'product', 'label' => $t('製品名'), 'type' => 'text', 'is_title' => true, 'required' => true],
					['key' => 'version', 'label' => $t('バージョン'), 'type' => 'text'],
					['key' => 'license_key', 'label' => $t('ライセンスキー'), 'type' => 'text', 'secret' => true],
					['key' => 'email', 'label' => $t('登録メール'), 'type' => 'email'],
					['key' => 'purchased', 'label' => $t('購入日'), 'type' => 'date'],
					['key' => 'url', 'label' => $t('ダウンロードURL'), 'type' => 'url'],
					['key' => 'memo', 'label' => $t('メモ'), 'type' => 'textarea'],
				],
			],
			[
				'key' => 'contact_personal', 'name' => $t('連絡先（個人）'), 'icon' => '👤', 'color' => '#0ea5e9',
				'description' => $t('友人・知人など個人の連絡先（顔写真つき）'),
				'fields' => [
					['key' => 'name', 'label' => $t('氏名'), 'type' => 'text', 'is_title' => true, 'required' => true],
					['key' => 'reading', 'label' => $t('ふりがな'), 'type' => 'text'],
					['key' => 'photo', 'label' => $t('顔写真'), 'type' => 'image_crop', 'options' => ['ratio' => '1:1', 'out' => 600]],
					['key' => 'nickname', 'label' => $t('ニックネーム'), 'type' => 'text'],
					['key' => 'mobile', 'label' => $t('携帯電話'), 'type' => 'tel', 'options' => ['charset' => 'phone', 'max' => 20]],
					['key' => 'phone', 'label' => $t('電話（自宅）'), 'type' => 'tel', 'options' => ['charset' => 'phone', 'max' => 20]],
					['key' => 'email', 'label' => $t('メール'), 'type' => 'email'],
					['key' => 'sns', 'label' => 'LINE / SNS', 'type' => 'text'],
					['key' => 'birthday', 'label' => $t('誕生日'), 'type' => 'date'],
					['key' => 'address', 'label' => $t('住所'), 'type' => 'textarea'],
					['key' => 'relation', 'label' => $t('関係'), 'type' => 'select', 'options' => [$t('家族'), $t('友人'), $t('知人'), $t('仕事'), $t('その他')]],
					['key' => 'memo', 'label' => $t('メモ'), 'type' => 'textarea'],
				],
			],
			[
				'key' => 'contact_customer', 'name' => $t('連絡先（顧客）'), 'icon' => '💼', 'color' => '#0d9488',
				'description' => $t('取引先・顧客の連絡先（会社・担当者・区分）'),
				'fields' => [
					['key' => 'company', 'label' => $t('会社名'), 'type' => 'text', 'is_title' => true, 'required' => true],
					['key' => 'company_reading', 'label' => $t('ふりがな（会社）'), 'type' => 'text'],
					['key' => 'logo', 'label' => $t('会社ロゴ'), 'type' => 'image', 'options' => ['max' => 400]],
					['key' => 'contact_name', 'label' => $t('担当者名'), 'type' => 'text'],
					['key' => 'department', 'label' => $t('部署'), 'type' => 'text'],
					['key' => 'position', 'label' => $t('役職'), 'type' => 'text'],
					['key' => 'phone', 'label' => $t('電話'), 'type' => 'tel', 'options' => ['charset' => 'phone', 'max' => 20]],
					['key' => 'mobile', 'label' => $t('携帯'), 'type' => 'tel', 'options' => ['charset' => 'phone', 'max' => 20]],
					['key' => 'fax', 'label' => 'FAX', 'type' => 'tel', 'options' => ['charset' => 'phone', 'max' => 20]],
					['key' => 'email', 'label' => $t('メール'), 'type' => 'email'],
					['key' => 'url', 'label' => $t('ウェブサイト'), 'type' => 'url', 'placeholder' => 'https://'],
					['key' => 'postal', 'label' => $t('郵便番号'), 'type' => 'text', 'options' => ['charset' => 'custom', 'pattern' => '\\d{3}-?\\d{4}']],
					['key' => 'address', 'label' => $t('住所'), 'type' => 'textarea'],
					['key' => 'customer_id', 'label' => $t('顧客番号'), 'type' => 'text'],
					['key' => 'category', 'label' => $t('区分'), 'type' => 'select', 'options' => [$t('見込み'), $t('取引中'), $t('休眠'), $t('その他')]],
					['key' => 'last_contact', 'label' => $t('最終連絡日'), 'type' => 'date'],
					['key' => 'memo', 'label' => $t('メモ'), 'type' => 'textarea'],
				],
			],
			[
				'key' => 'blank', 'name' => $t('空のコレクション'), 'icon' => '📁', 'color' => '#64748b',
				'description' => $t('項目を自分で一から設計する'),
				'fields' => [
					['key' => 'title', 'label' => $t('タイトル'), 'type' => 'text', 'is_title' => true, 'required' => true],
					['key' => 'memo', 'label' => $t('メモ'), 'type' => 'textarea'],
				],
			],
		];
	}

	public static function byKey(IL10N $l, string $key): ?array {
		foreach (self::all($l) as $t) {
			if ($t['key'] === $key) {
				return $t;
			}
		}
		return null;
	}
}
