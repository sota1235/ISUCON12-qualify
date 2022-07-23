USE `isuports`;

DROP TABLE IF EXISTS `first_visit_history`;

CREATE TABLE `first_visit_history` (
                                       `player_id` VARCHAR(255) NOT NULL,
                                       `tenant_id` BIGINT UNSIGNED NOT NULL,
                                       `competition_id` VARCHAR(255) NOT NULL,
                                       `created_at` BIGINT NOT NULL,
                                       UNIQUE KEY `tenant_competition` (`tenant_id`, `competition_id`),
                                       INDEX `player_tenant_competition` (`player_id`, `tenant_id`, `competition_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4;
