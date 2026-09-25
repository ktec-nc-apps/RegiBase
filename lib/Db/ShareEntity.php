<?php

declare(strict_types=1);

namespace OCA\RegiBase\Db;

use OCP\AppFramework\Db\Entity;

/**
 * @method int getCollectionId()
 * @method void setCollectionId(int $v)
 * @method string getOwnerUid()
 * @method void setOwnerUid(string $v)
 * @method string getRecipientUid()
 * @method void setRecipientUid(string $v)
 * @method string getRecipientType()
 * @method void setRecipientType(string $v)
 * @method string getPerm()
 * @method void setPerm(string $v)
 * @method ?string getPwHash()
 * @method void setPwHash(?string $v)
 * @method ?string getEncKey()
 * @method void setEncKey(?string $v)
 * @method ?string getEncSalt()
 * @method void setEncSalt(?string $v)
 * @method ?string getExpiresAt()
 * @method void setExpiresAt(?string $v)
 * @method ?string getAuthSalt()
 * @method void setAuthSalt(?string $v)
 * @method string getCreatedAt()
 * @method void setCreatedAt(string $v)
 */
class ShareEntity extends Entity implements \JsonSerializable {
	protected $collectionId = 0;
	protected $ownerUid = '';
	protected $recipientUid = '';
	protected $recipientType = 'user';
	protected $perm = 'view';
	protected $pwHash = null;
	protected $encKey = null;
	protected $encSalt = null;
	protected $expiresAt = null;
	protected $authSalt = null;
	protected $createdAt = '';

	public function __construct() {
		$this->addType('collectionId', 'integer');
	}

	/**
	 * A share whose end date has gone by. The date is the last day it works, in the
	 * owner's own time zone: a share ending on the 23rd in Japan ends at midnight
	 * Japanese time, not nine hours later at midnight UTC.
	 */
	public static function isPast(?string $date, ?string $tz = null): bool {
		if ($date === null || $date === '') {
			return false;
		}
		try {
			$zone = new \DateTimeZone($tz ?: date_default_timezone_get());
		} catch (\Throwable $e) {
			$zone = new \DateTimeZone('UTC');
		}
		$end = \DateTime::createFromFormat('Y-m-d H:i:s', substr($date, 0, 10) . ' 23:59:59', $zone);
		return $end !== false && $end->getTimestamp() < time();
	}

	/** The owner's time zone (their Nextcloud setting), else the server's default. */
	public static function ownerZone(string $uid): string {
		$cfg = \OCP\Server::get(\OCP\IConfig::class);
		$tz = $cfg->getUserValue($uid, 'core', 'timezone', '');
		return $tz !== '' ? $tz : $cfg->getSystemValueString('default_timezone', 'UTC');
	}

	public function jsonSerialize(): array {
		return [
			'id' => (int)$this->id,
			'collection_id' => (int)$this->collectionId,
			'owner_uid' => $this->ownerUid,
			'recipient_uid' => $this->recipientUid,
			'recipient_type' => $this->recipientType,
			'perm' => $this->perm,
			// never expose the hash or wrapped key material; only whether they exist
			'has_password' => $this->pwHash !== null && $this->pwHash !== '',
			'shares_secrets' => $this->encKey !== null && $this->encKey !== '',
			'expires_at' => $this->expiresAt,
			'expired' => self::isPast($this->expiresAt, self::ownerZone((string)$this->ownerUid)),
			'created_at' => $this->createdAt,
		];
	}
}
