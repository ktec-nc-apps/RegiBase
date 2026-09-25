<?php

declare(strict_types=1);

namespace OCA\RegiBase\AppInfo;

use OCA\RegiBase\Listener\AccountDeletedListener;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;
use OCP\Group\Events\GroupDeletedEvent;
use OCP\User\Events\UserDeletedEvent;

class Application extends App implements IBootstrap {
	public const APP_ID = 'regibase';

	public function __construct() {
		parent::__construct(self::APP_ID);
	}

	public function register(IRegistrationContext $context): void {
		$context->registerEventListener(UserDeletedEvent::class, AccountDeletedListener::class);
		$context->registerEventListener(GroupDeletedEvent::class, AccountDeletedListener::class);
	}

	public function boot(IBootContext $context): void {
	}
}
